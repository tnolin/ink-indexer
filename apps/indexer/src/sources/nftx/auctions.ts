import type { Sql } from "@ink-indexer/db"
import { type NftAuctionEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import {
  auctionPriceWei,
  CCA_FACTORY,
  type CcaLog,
  type ChainLog,
  decodeCcaLog,
  INK_CHAIN_ID,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import { BLOCK_S } from "../nft/policy"
import { servedAt } from "../senders"
import type { EventRow } from "../source"

// Uniswap continuous clearing auctions. Every auction the factory creates is stored with its bids;
// only those that sell a collection's own floor token, or that NFTX's launchpad started for a
// launch, are announced (ADR 0044, ADR 0046).

const ZERO: Address = "0x0000000000000000000000000000000000000000"
const E18 = 10n ** 18n

/** One auction the factory created, as stored. */
export type StoredAuction = {
  auction: Address
  token: Address
  currency: Address
  startBlock: bigint
  endBlock: bigint
  claimBlock: bigint
  /** The starting minimum bid, Q96 currency per token unit. */
  floorPriceQ96: bigint
  requiredRaise: bigint
  /** Tokens the factory call named. */
  amount: bigint
  /** What the auction reported receiving; null until `TokensReceived`. */
  totalSupply: bigint | null
  /** Sender and target of the creating transaction. */
  sender: Address
  txTo: Address | null
  createdBlock: bigint
  createdLogIndex: number
  collection: Address | null
  kept: boolean
  keptBlock: bigint | null
  /** Linked by hand; a rollback does not unkeep it. */
  manual: boolean
  tokensReceivedBlock: bigint | null
  createdEmittedBlock: bigint | null
  liveBlock: bigint | null
  endedBlock: bigint | null
}

export type KeptAuction = StoredAuction & { kept: true; collection: Address }

export type KeepCollection = { collection: Address; floorToken: Address; creator: Address }

/**
 * Whether the auction is the collection's own: it sells the collection's floor token, for ETH, at
 * least half of that token's supply, was started by the collection's creator, its `owner()` or the
 * NFTX launchpad, and is the collection's first such auction. Anyone can start an auction of any
 * token they hold, so each condition keeps a stranger's auction from being announced as the
 * collection's.
 */
export function keepAuction(
  a: StoredAuction,
  c: {
    collection: KeepCollection | null
    owner: Address | null
    floorSupply: bigint | null
    launchpad: Address | null
    alreadyKept: boolean
  },
): boolean {
  const col = c.collection
  if (!col || a.token !== col.floorToken) return false
  // A token with no supply at the auction's block does not exist there yet, and half of nothing is
  // met by any amount.
  if (a.currency !== ZERO || c.alreadyKept || c.floorSupply === null || c.floorSupply === 0n)
    return false
  const sender =
    a.sender === col.creator ||
    (c.owner !== null && a.sender === c.owner) ||
    (c.launchpad !== null && (a.sender === c.launchpad || a.txTo === c.launchpad))
  return sender && a.amount * 2n >= c.floorSupply
}

/**
 * The phases a kept auction has reached by `toBlock` and not yet announced. Bidding opens at the
 * later of the start block and the arrival of the tokens: bids revert before it.
 */
export function duePhases(
  a: KeptAuction,
  toBlock: bigint,
): { live: bigint | null; ended: bigint | null } {
  const liveAt =
    a.tokensReceivedBlock === null
      ? null
      : a.tokensReceivedBlock > a.startBlock
        ? a.tokensReceivedBlock
        : a.startBlock
  return {
    live: a.liveBlock === null && liveAt !== null && liveAt <= toBlock ? liveAt : null,
    ended: a.endedBlock === null && a.endBlock <= toBlock ? a.endBlock : null,
  }
}

type Phase = NftAuctionEvent["phase"]

/** The id of an auction event: its block, and the log's index for a phase that comes from a log. */
export const auctionEventId = (auction: Address, phase: Phase, block: bigint, logIndex?: number) =>
  `nftx:auction:${auction}:${phase}:${block}${logIndex === undefined ? "" : `:${logIndex}`}`

export type PhasePoint = { block: bigint; ts: number; logIndex?: number }

export type PhaseState = {
  /** Per NFT. */
  clearingPriceWei: bigint
  raisedWei: bigint
  bidders: number
  /** `ended` only. */
  ended: { graduated: boolean; clearedTokens: bigint } | null
  slug: string | null
}

/** The event for one phase. Times ahead of `at` are estimated from the block time. */
export function auctionEvent(
  a: KeptAuction,
  phase: Phase,
  at: PhasePoint,
  state: PhaseState,
): NftAuctionEvent {
  const eta = (block: bigint) => at.ts + Number(block - at.block) * BLOCK_S
  const txHash = auctionEventId(a.auction, phase, at.block, at.logIndex)
  return {
    v: SCHEMA_VERSION,
    chainId: INK_CHAIN_ID,
    type: "nft.auction",
    contract: a.collection,
    source: "chain",
    txHash,
    logIndex: at.logIndex ?? 0,
    blockNumber: at.block.toString(),
    blockTimestamp: at.ts,
    phase,
    auction: a.auction,
    token: a.token,
    currency: a.currency === ZERO ? "ETH" : a.currency,
    startBlock: a.startBlock.toString(),
    endBlock: a.endBlock.toString(),
    claimBlock: a.claimBlock.toString(),
    startsAt: eta(a.startBlock),
    endsAt: eta(a.endBlock),
    claimsAt: eta(a.claimBlock),
    supply: ((a.totalSupply ?? a.amount) / E18).toString(),
    minBidWei: auctionPriceWei(a.floorPriceQ96).toString(),
    clearingPriceWei: state.clearingPriceWei.toString(),
    raisedWei: state.raisedWei.toString(),
    requiredRaiseWei: a.requiredRaise.toString(),
    bidders: state.bidders,
    graduated: state.ended?.graduated ?? null,
    // An auction that does not graduate refunds its bids: it sells nothing.
    cleared: state.ended
      ? (state.ended.graduated ? state.ended.clearedTokens / E18 : 0n).toString()
      : null,
    nftxSlug: state.slug,
  }
}

export type BidRow = {
  auction: Address
  block: bigint
  logIndex: number
  kind: "bid" | "exit" | "claim"
  bidId: bigint
  owner: Address
}

/** A stored auction, with whether this batch created it. */
export type AuctionRow = StoredAuction & { isNew: boolean }

export type AuctionPlan = {
  /** Auctions created or changed in the batch, in their final state. */
  rows: AuctionRow[]
  bids: BidRow[]
  events: EventRow[]
  blocks: { number: bigint; hash: Hash }[]
}

export type AuctionDeps = {
  sql: Sql
  chain: Pick<
    Chain,
    "getBlock" | "getBlockSenders" | "readOwners" | "readTotalSupplies" | "readAuctionCheckpoint"
  >
  logger: Logger
  launchpad: Address | null
}

/** A launch the launchpad created: its collection, claim token and the auction that sells it. */
export type LaunchInput = {
  collection: Address
  floorToken: Address
  creator: Address
  claimToken: Address
  auction: Address
  block: bigint
}

export type AuctionInput = {
  /** The factory's `AuctionCreated` logs. */
  factoryLogs: ChainLog[]
  /** Every log of an auction topic from any address: only those of stored or new auctions count. */
  auctionLogs: ChainLog[]
  /** The launchpad's `LaunchCreated` logs of the batch. */
  launches: LaunchInput[]
  /** Collections created in this batch. */
  created: { collection: Address; floorToken: Address; creator: Address; block: bigint }[]
  /** Slugs fetched in this batch. */
  slugs: Map<Address, string>
  toBlock: bigint
}

type DbRow = {
  auction: Address
  token: Address
  currency: Address
  start_block: string
  end_block: string
  claim_block: string
  floor_price_q96: string
  required_raise: string
  amount: string
  total_supply: string | null
  sender: Address
  tx_to: Address | null
  created_block: string
  created_log_index: number
  collection: Address | null
  kept: boolean
  kept_block: string | null
  manual: boolean
  tokens_received_block: string | null
  created_emitted_block: string | null
  live_block: string | null
  ended_block: string | null
}

const big = (v: string | null) => (v === null ? null : BigInt(v))

const fromDb = (r: DbRow): StoredAuction => ({
  auction: r.auction,
  token: r.token,
  currency: r.currency,
  startBlock: BigInt(r.start_block),
  endBlock: BigInt(r.end_block),
  claimBlock: BigInt(r.claim_block),
  floorPriceQ96: BigInt(r.floor_price_q96),
  requiredRaise: BigInt(r.required_raise),
  amount: BigInt(r.amount),
  totalSupply: big(r.total_supply),
  sender: r.sender,
  txTo: r.tx_to,
  createdBlock: BigInt(r.created_block),
  createdLogIndex: r.created_log_index,
  collection: r.collection,
  kept: r.kept,
  keptBlock: big(r.kept_block),
  manual: r.manual,
  tokensReceivedBlock: big(r.tokens_received_block),
  createdEmittedBlock: big(r.created_emitted_block),
  liveBlock: big(r.live_block),
  endedBlock: big(r.ended_block),
})

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

/**
 * Reads the batch's auction logs and the stored auctions, decides which auctions are kept, and
 * builds the events and rows to write. Network reads only; nothing is written here.
 *
 * Auctions that other processes link by hand (`nft:auction`) are picked up because every batch
 * reads the stored auctions that still have a phase to announce.
 */
export async function planAuctions(deps: AuctionDeps, input: AuctionInput): Promise<AuctionPlan> {
  const { sql, chain, launchpad } = deps
  const plan: AuctionPlan = { rows: [], bids: [], events: [], blocks: [] }

  const creations: { log: ChainLog; d: Extract<CcaLog, { kind: "auctionCreated" }> }[] = []
  for (const log of [...input.factoryLogs].sort(byPosition)) {
    if (log.address !== CCA_FACTORY) continue
    const d = decodeCcaLog(log)
    if (d?.kind === "auctionCreated") creations.push({ log, d })
  }
  const logs: { log: ChainLog; d: Exclude<CcaLog, { kind: "auctionCreated" }> }[] = []
  for (const log of [...input.auctionLogs].sort(byPosition)) {
    const d = decodeCcaLog(log)
    if (d && d.kind !== "auctionCreated") logs.push({ log, d })
  }

  const ids = [
    ...new Set([...creations.map((c) => c.d.auction), ...logs.map((l) => l.log.address)]),
  ]
  const createdTokens = new Set(input.created.map((c) => c.floorToken))
  const launchOf = new Map(input.launches.map((l) => [l.auction, l]))
  // Stored auctions with a phase still to announce are read on every batch: another process may
  // have linked one since the last.
  const stored = await sql<DbRow[]>`
    select auction, token, currency, start_block::text, end_block::text, claim_block::text,
      floor_price_q96::text, required_raise::text, amount::text, total_supply::text, sender, tx_to,
      created_block::text, created_log_index, collection, kept, kept_block::text, manual,
      tokens_received_block::text, created_emitted_block::text, live_block::text, ended_block::text
    from indexer.nftx_auctions
    where auction = any(${sql.array(ids)}::text[])
      or auction = any(${sql.array([...launchOf.keys()])}::text[])
      or token = any(${sql.array([...createdTokens])}::text[])
      or (kept and (created_emitted_block is null or live_block is null or ended_block is null))`
  const auctions = new Map<Address, StoredAuction>(stored.map((r) => [r.auction, fromDb(r)]))
  const isNew = new Set<Address>()
  const dirty = new Set<Address>()
  const keptAtCreation = new Set<Address>()

  // Block reads, once each.
  const senders = new Map<bigint, Awaited<ReturnType<Chain["getBlockSenders"]>>>()
  const senderBlock = async (n: bigint) => {
    if (!senders.has(n)) senders.set(n, await servedAt(n, () => chain.getBlockSenders(n)))
    const b = senders.get(n)
    if (!b) throw new BlockNotServedError(n)
    return b
  }
  const headers = new Map<bigint, { hash: Hash; ts: number }>()
  const header = async (n: bigint) => {
    const known = headers.get(n)
    if (known) return known
    const b = await servedAt(n, () => chain.getBlock(n))
    if (!b) throw new BlockNotServedError(n)
    const h = { hash: b.hash, ts: Number(b.timestamp) }
    headers.set(n, h)
    return h
  }
  const seen = new Map<bigint, Hash>()
  const see = (number: bigint, hash: Hash) => seen.set(number, hash)

  for (const { log, d } of creations) {
    if (auctions.has(d.auction)) continue
    const meta = await senderBlock(log.blockNumber)
    // The logs and the block can come from different endpoints on either side of a reorg.
    const from = meta.senders.get(log.transactionHash)
    if (meta.hash !== log.blockHash || from === undefined)
      throw new BlockNotServedError(log.blockNumber)
    auctions.set(d.auction, {
      auction: d.auction,
      token: d.token,
      currency: d.config.currency,
      startBlock: d.config.startBlock,
      endBlock: d.config.endBlock,
      claimBlock: d.config.claimBlock,
      floorPriceQ96: d.config.floorPrice,
      requiredRaise: d.config.requiredCurrencyRaised,
      amount: d.amount,
      totalSupply: null,
      sender: from,
      txTo: meta.targets.get(log.transactionHash) ?? null,
      createdBlock: log.blockNumber,
      createdLogIndex: log.logIndex,
      collection: null,
      kept: false,
      keptBlock: null,
      manual: false,
      tokensReceivedBlock: null,
      createdEmittedBlock: null,
      liveBlock: null,
      endedBlock: null,
    })
    isNew.add(d.auction)
    dirty.add(d.auction)
    see(log.blockNumber, log.blockHash)
  }

  const priceLogs: { a: StoredAuction; log: ChainLog; priceQ96: bigint }[] = []
  for (const { log, d } of logs) {
    const a = auctions.get(log.address)
    if (!a) continue
    switch (d.kind) {
      case "tokensReceived":
        if (a.tokensReceivedBlock === null) {
          a.tokensReceivedBlock = log.blockNumber
          a.totalSupply = d.totalSupply
          dirty.add(a.auction)
        }
        break
      case "bid":
        plan.bids.push({
          auction: a.auction,
          block: log.blockNumber,
          logIndex: log.logIndex,
          kind: "bid",
          bidId: d.id,
          owner: d.owner,
        })
        break
      case "exited":
        plan.bids.push({
          auction: a.auction,
          block: log.blockNumber,
          logIndex: log.logIndex,
          kind: "exit",
          bidId: d.bidId,
          owner: d.owner,
        })
        break
      case "claimed":
        plan.bids.push({
          auction: a.auction,
          block: log.blockNumber,
          logIndex: log.logIndex,
          kind: "claim",
          bidId: d.bidId,
          owner: d.owner,
        })
        break
      case "clearingPrice":
        // The auction also logs its starting price when it is created, before bidding opens.
        if (d.checkpointBlock >= a.startBlock && d.checkpointBlock <= a.endBlock)
          priceLogs.push({ a, log, priceQ96: d.priceQ96 })
        break
    }
  }

  // Keep check: for auctions created in this batch, and for stored ones whose floor token's
  // collection was created in it.
  const toCheck = [...auctions.values()]
    .filter(
      (a) =>
        !a.kept && (isNew.has(a.auction) || createdTokens.has(a.token) || launchOf.has(a.auction)),
    )
    .sort((x, y) =>
      x.createdBlock === y.createdBlock
        ? x.createdLogIndex - y.createdLogIndex
        : x.createdBlock < y.createdBlock
          ? -1
          : 1,
    )
  if (toCheck.length > 0) {
    const tokens = [...new Set(toCheck.map((a) => a.token))]
    const rows = await sql<
      { collection: Address; floor_token: Address; creator: Address; created_block: string }[]
    >`
      select collection, floor_token, creator, created_block::text from indexer.nftx_collections
      where floor_token = any(${sql.array(tokens)}::text[])`
    const collections = new Map<Address, KeepCollection & { createdBlock: bigint }>(
      rows.map((r) => [
        r.floor_token,
        {
          collection: r.collection,
          floorToken: r.floor_token,
          creator: r.creator,
          createdBlock: BigInt(r.created_block),
        },
      ]),
    )
    for (const c of input.created)
      collections.set(c.floorToken, {
        collection: c.collection,
        floorToken: c.floorToken,
        creator: c.creator,
        createdBlock: c.block,
      })
    const owned = [...new Set([...collections.values()].map((c) => c.collection))]
    const keptRows = await sql<{ collection: Address }[]>`
      select distinct collection from indexer.nftx_auctions
      where kept and collection = any(${sql.array(owned)}::text[])`
    const keptCollections = new Set<Address>(keptRows.map((r) => r.collection))
    for (const a of auctions.values()) if (a.kept && a.collection) keptCollections.add(a.collection)

    for (const a of toCheck) {
      // The launchpad creates the collection and starts its auction in one transaction, so the
      // auction it names, selling the claim token it names, is the collection's own. The factory
      // log is the proof that the auction exists, and it was created in the launch's block; no floor-token, currency or sender check applies.
      const launch = launchOf.get(a.auction)
      if (launch && a.token === launch.claimToken && a.createdBlock === launch.block) {
        a.kept = true
        a.collection = launch.collection
        a.keptBlock = launch.block > a.createdBlock ? launch.block : a.createdBlock
        dirty.add(a.auction)
        keptCollections.add(launch.collection)
        if (isNew.has(a.auction)) keptAtCreation.add(a.auction)
        continue
      }
      const col = collections.get(a.token)
      if (!col) continue
      const already = keptCollections.has(col.collection)
      const open = a.currency === ZERO && !already
      const direct =
        a.sender === col.creator ||
        (launchpad !== null && (a.sender === launchpad || a.txTo === launchpad))
      // Reads only for an auction the cheap conditions have not refused.
      const owner =
        open && !direct
          ? ((await chain.readOwners([col.collection], a.createdBlock))[0] ?? null)
          : null
      const floorSupply =
        open && (direct || (owner !== null && owner === a.sender))
          ? ((await chain.readTotalSupplies([a.token], a.createdBlock))[0] ?? null)
          : null
      if (!keepAuction(a, { collection: col, owner, floorSupply, launchpad, alreadyKept: already }))
        continue
      a.kept = true
      a.collection = col.collection
      a.keptBlock = col.createdBlock > a.createdBlock ? col.createdBlock : a.createdBlock
      dirty.add(a.auction)
      keptCollections.add(col.collection)
      if (isNew.has(a.auction) && col.createdBlock <= a.createdBlock) keptAtCreation.add(a.auction)
    }
  }

  // What each kept auction announces now.
  type Emit =
    | { kind: "created"; a: KeptAuction; at: "log" | "batch"; block: bigint }
    | { kind: "live"; a: KeptAuction; block: bigint }
    | { kind: "price"; a: KeptAuction; log: ChainLog; priceQ96: bigint }
    | { kind: "ended"; a: KeptAuction; block: bigint }
  const emits: Emit[] = []
  const keptNow = [...auctions.values()]
    .filter((a): a is KeptAuction => a.kept && a.collection !== null)
    .sort((x, y) =>
      x.createdBlock === y.createdBlock
        ? x.createdLogIndex - y.createdLogIndex
        : x.createdBlock < y.createdBlock
          ? -1
          : 1,
    )
  for (const a of keptNow) {
    const due = duePhases(a, input.toBlock)
    if (a.createdEmittedBlock === null) {
      const atLog = keptAtCreation.has(a.auction)
      // A keep that comes after the auction has started is announced at the block of its first
      // announced phase, so `created` never follows `live`, a price or `ended`.
      const block = [
        input.toBlock,
        ...(due.live === null ? [] : [due.live]),
        ...priceLogs.filter((p) => p.a.auction === a.auction).map((p) => p.log.blockNumber),
        ...(due.ended === null ? [] : [due.ended]),
      ].reduce((m, b) => (b < m ? b : m))
      emits.push({ kind: "created", a, at: atLog ? "log" : "batch", block })
      a.createdEmittedBlock = atLog ? a.createdBlock : block
      dirty.add(a.auction)
    }
    if (due.live !== null) {
      emits.push({ kind: "live", a, block: due.live })
      a.liveBlock = due.live
      dirty.add(a.auction)
    }
    // A price older than the block `created` was announced at would follow it out of order.
    for (const p of priceLogs)
      if (
        p.a.auction === a.auction &&
        (a.createdEmittedBlock === null || p.log.blockNumber >= a.createdEmittedBlock)
      )
        emits.push({ kind: "price", a, log: p.log, priceQ96: p.priceQ96 })
    if (due.ended !== null) {
      emits.push({ kind: "ended", a, block: due.ended })
      a.endedBlock = due.ended
      dirty.add(a.auction)
    }
  }

  if (emits.length > 0) {
    const emitting = [...new Set(emits.map((e) => e.a.auction))]
    const collectionsOf = [...new Set(emits.map((e) => e.a.collection))]
    const slugs = new Map<Address, string | null>()
    for (const r of await sql<{ contract: Address; nftx_slug: string | null }[]>`
      select contract, nftx_slug from indexer.nft_collections
      where contract = any(${sql.array(collectionsOf)}::text[])`)
      slugs.set(r.contract, r.nftx_slug)
    for (const [c, s] of input.slugs) slugs.set(c, s)
    // Stored bids and this batch's own, so a re-read span counts each bid once.
    const owners = new Map<Address, { owner: Address; block: bigint; logIndex: number }[]>()
    for (const r of await sql<
      { auction: Address; owner: Address; block: string; log_index: number }[]
    >`
      select auction, owner, block::text, log_index from indexer.nftx_auction_bids
      where kind = 'bid' and auction = any(${sql.array(emitting)}::text[])`)
      owners.set(r.auction, [
        ...(owners.get(r.auction) ?? []),
        { owner: r.owner, block: BigInt(r.block), logIndex: r.log_index },
      ])
    for (const b of plan.bids)
      if (b.kind === "bid" && emitting.includes(b.auction))
        owners.set(b.auction, [
          ...(owners.get(b.auction) ?? []),
          { owner: b.owner, block: b.block, logIndex: b.logIndex },
        ])
    // shortcut: every stored bid of a kept auction is read when a phase is announced; a running
    // bidder count on the auction row if one ever has bids in the tens of thousands.
    const biddersAt = (auction: Address, block: bigint, logIndex?: number) =>
      new Set(
        (owners.get(auction) ?? [])
          .filter(
            (b) =>
              b.block < block ||
              (b.block === block && (logIndex === undefined || b.logIndex <= logIndex)),
          )
          .map((b) => b.owner),
      ).size
    const checkpointAt = (a: KeptAuction, block: bigint) =>
      chain.readAuctionCheckpoint(a.auction, block)
    const price = (q96: bigint) => auctionPriceWei(q96)
    const minBid = (a: KeptAuction) => price(a.floorPriceQ96)
    const push = (event: NftAuctionEvent, hash: Hash) => {
      plan.events.push({ event, block: BigInt(event.blockNumber), blockHash: hash, sub: "" })
      see(BigInt(event.blockNumber), hash)
    }

    for (const e of emits) {
      const a = e.a
      const slug = slugs.get(a.collection) ?? null
      switch (e.kind) {
        case "created": {
          if (e.at === "log") {
            const meta = await senderBlock(a.createdBlock)
            push(
              auctionEvent(
                a,
                "created",
                { block: a.createdBlock, ts: meta.timestamp, logIndex: a.createdLogIndex },
                {
                  clearingPriceWei: minBid(a),
                  raisedWei: 0n,
                  bidders: biddersAt(a.auction, a.createdBlock, a.createdLogIndex),
                  ended: null,
                  slug,
                },
              ),
              meta.hash,
            )
          } else {
            const h = await header(e.block)
            push(
              auctionEvent(
                a,
                "created",
                { block: e.block, ts: h.ts },
                {
                  clearingPriceWei: minBid(a),
                  raisedWei: 0n,
                  bidders: biddersAt(a.auction, e.block),
                  ended: null,
                  slug,
                },
              ),
              h.hash,
            )
          }
          break
        }
        case "live": {
          const h = await header(e.block)
          const cp = await checkpointAt(a, e.block)
          push(
            auctionEvent(
              a,
              "live",
              { block: e.block, ts: h.ts },
              {
                clearingPriceWei: cp ? price(cp.clearingPriceQ96) : minBid(a),
                raisedWei: cp?.currencyRaised ?? 0n,
                bidders: biddersAt(a.auction, e.block),
                ended: null,
                slug,
              },
            ),
            h.hash,
          )
          break
        }
        case "price": {
          const cp = await checkpointAt(a, e.log.blockNumber)
          if (!cp)
            throw new Error(`auction ${a.auction}: no checkpoint at block ${e.log.blockNumber}`)
          const h = await header(e.log.blockNumber)
          push(
            auctionEvent(
              a,
              "price",
              { block: e.log.blockNumber, ts: h.ts, logIndex: e.log.logIndex },
              {
                clearingPriceWei: price(e.priceQ96),
                raisedWei: cp.currencyRaised,
                bidders: biddersAt(a.auction, e.log.blockNumber, e.log.logIndex),
                ended: null,
                slug,
              },
            ),
            e.log.blockHash,
          )
          break
        }
        case "ended": {
          const h = await header(e.block)
          const cp = await checkpointAt(a, e.block)
          // No tokens ever arrived, so the auction never opened and the checkpoint reverts.
          if (!cp && a.tokensReceivedBlock !== null)
            throw new Error(`auction ${a.auction}: no checkpoint at its end block ${e.block}`)
          push(
            auctionEvent(
              a,
              "ended",
              { block: e.block, ts: h.ts },
              {
                clearingPriceWei: cp ? price(cp.clearingPriceQ96) : minBid(a),
                raisedWei: cp?.currencyRaised ?? 0n,
                bidders: biddersAt(a.auction, e.block),
                ended: { graduated: cp?.graduated ?? false, clearedTokens: cp?.totalCleared ?? 0n },
                slug,
              },
            ),
            h.hash,
          )
          break
        }
      }
    }
  }

  plan.rows = [...dirty].map((id) => ({ ...auctions.get(id)!, isNew: isNew.has(id) }))
  plan.blocks = [...seen].map(([number, hash]) => ({ number, hash }))
  return plan
}
