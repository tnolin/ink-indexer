import type { ChainLog } from "@ink-indexer/sdk"
import type { Address, Hex } from "viem"
import type { Chain } from "./chain"
import type { LogFilter } from "./rpc"

/** One logical filter of one source: where its logs go back to. */
export type Slot = { source: number; index: number; filter: LogFilter }
/** One eth_getLogs request and the slots whose logs it carries. */
export type Request = { filter: LogFilter; members: Slot[] }

const lower = (s: string) => s.toLowerCase()
const list = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x])
const uniq = <T extends string>(xs: T[]) => [...new Set(xs.map((x) => lower(x) as T))]

/** The topic0 alternatives a filter allows; undefined when it allows any. */
const topic0Of = (f: LogFilter): Hex[] | undefined => {
  const t = f.topics[0]
  return t === undefined || t === null ? undefined : list(t)
}

/**
 * Merges the logical filters into the fewest eth_getLogs requests that return, between them, every
 * log each filter would have. Two kinds of merge are safe:
 *
 * - Filters with the same address and identical topics after position 0 differ only in topic0, so
 *   their topic0s are ORed into one position. The request returns exactly the union of the
 *   filters' logs: no extra log.
 * - Address-bound filters with at most a topic0 restriction are ORed as an address list. The
 *   request is the cross product of the addresses and the topic0s (the topic0 position is left
 *   open when any member allows every event of its contract), so it can return logs that only
 *   another member's address or topic0 asked for. `splitLogs` drops them.
 *
 * Topic positions beyond 0 cannot be ORed with each other, so filters that constrain different
 * positions stay separate requests. A request with one member is that member's filter, unchanged.
 */
export function planRequests(slots: Slot[]): Request[] {
  const groups = new Map<string, Slot[]>()
  for (const slot of slots) {
    const { address, topics } = slot.filter
    const key =
      address !== undefined && topics.length <= 1
        ? "addresses"
        : `${JSON.stringify(address === undefined ? null : uniq(list(address)))}|${JSON.stringify(topics.slice(1))}`
    const g = groups.get(key)
    if (g) g.push(slot)
    else groups.set(key, [slot])
  }
  return [...groups.values()].map((members) => ({ filter: merged(members), members }))
}

function merged(members: Slot[]): LogFilter {
  if (members.length === 1) return members[0]!.filter
  const fs = members.map((m) => m.filter)
  const tails = fs[0]!.topics.slice(1)
  const t0s = fs.map(topic0Of)
  const topic0 = t0s.every((t) => t !== undefined) ? uniq(t0s.flat() as Hex[]) : undefined
  const topics: LogFilter["topics"] =
    topic0 !== undefined ? [topic0, ...tails] : tails.length > 0 ? [null, ...tails] : []
  const addresses = fs.map((f) => f.address)
  return addresses[0] === undefined
    ? { topics }
    : { address: uniq(addresses.flatMap((a) => list(a as Address | Address[]))), topics }
}

/** eth_getLogs matching: the address, then each topic position (null matches anything, an array any of its topics). */
export function matches(l: ChainLog, f: LogFilter): boolean {
  if (f.address !== undefined && !list(f.address).some((a) => lower(a) === lower(l.address)))
    return false
  if (f.topics.length > l.topics.length) return false
  return f.topics.every(
    (want, i) => want === null || list(want).some((t) => lower(t) === lower(l.topics[i] ?? "")),
  )
}

/**
 * The logs of one request, per member in `members` order: those the member's own filter matches,
 * so a log two filters both match goes to both, and a log only the merge fetched goes to none.
 * A merged response is sorted by block, then log index; a single-member response is as returned.
 */
export function splitLogs(logs: ChainLog[], req: Request): ChainLog[][] {
  if (req.members.length === 1) return [logs]
  const sorted = [...logs].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  )
  return req.members.map((m) => sorted.filter((l) => matches(l, m.filter)))
}

/** One request per slot, in slot order: the filters as the sources declared them. */
const separately = (slots: Slot[]): Request[] =>
  slots.map((slot) => ({ filter: slot.filter, members: [slot] }))

/**
 * Reads the logs of every source's filters for one span. `filters[s][i]` is source `s`'s filter `i`
 * (null: not read, an empty array in its place). Returns the logs in the same shape, each array
 * holding what its own filter would have returned, up to the final `toBlock`: the requests run in
 * turn, each asking up to the lowest end returned so far.
 */
export async function readLogs(
  chain: Pick<Chain, "getLogs">,
  filters: (LogFilter | null)[][],
  from: bigint,
  to: bigint,
  merge = true,
): Promise<{ logs: ChainLog[][][]; toBlock: bigint }> {
  const slots = filters.flatMap((fs, source) =>
    fs.flatMap((filter, index) => (filter === null ? [] : [{ source, index, filter }])),
  )
  let toBlock = to
  const logs = filters.map((fs) => fs.map((): ChainLog[] => []))
  const got: [Slot, ChainLog[]][] = []
  for (const req of merge ? planRequests(slots) : separately(slots)) {
    const r = await chain.getLogs(from, toBlock, req.filter)
    if (r.toBlock < toBlock) toBlock = r.toBlock
    for (const [i, ls] of splitLogs(r.logs, req).entries()) got.push([req.members[i]!, ls])
  }
  for (const [slot, ls] of got)
    logs[slot.source]![slot.index] = ls.filter((l) => l.blockNumber <= toBlock)
  return { logs, toBlock }
}
