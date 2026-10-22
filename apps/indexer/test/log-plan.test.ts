import {
  CHIMERA_FACTORY,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_5,
  SEAPORT_1_6,
  ZERO_TOPIC,
} from "@ink-indexer/sdk"
import { describe, expect, it } from "vitest"
import { planRequests, type Slot, splitLogs } from "../src/log-plan"
import type { LogFilter } from "../src/rpc"

const T = NFT_TOPICS.transfer
const B = [NFT_TOPICS.transferSingle, NFT_TOPICS.transferBatch]
const INKY: LogFilter = { topics: [["0x01", "0x02"] as never] }
const filters: LogFilter[] = [
  { topics: [T, ZERO_TOPIC] },
  { topics: [T, null, ZERO_TOPIC] },
  { topics: [B, null, ZERO_TOPIC] },
  { topics: [B, null, null, ZERO_TOPIC] },
  { address: SEADROP_V1, topics: [] },
  { address: [SEAPORT_1_6, SEAPORT_1_5], topics: [NFT_TOPICS.orderFulfilled] },
  { address: CHIMERA_FACTORY, topics: [NFT_TOPICS.campaignCreated] },
]
const slots = (fs: (LogFilter | null)[]): Slot[] =>
  fs.flatMap((filter, i) => (filter ? [{ source: 0, index: i, filter }] : []))

describe("planRequests", () => {
  it("merges the seven NFT filters into four requests", () => {
    const plan = planRequests(slots(filters))
    expect(plan.map((r) => r.filter)).toEqual([
      { topics: [T, ZERO_TOPIC] },
      { topics: [[T, ...B], null, ZERO_TOPIC] },
      { topics: [B, null, null, ZERO_TOPIC] },
      { address: [SEADROP_V1, SEAPORT_1_6, SEAPORT_1_5, CHIMERA_FACTORY], topics: [] },
    ])
    expect(plan.map((r) => r.members.map((m) => m.index))).toEqual([[0], [1, 2], [3], [4, 5, 6]])
  })

  it("restricts the address request to the union of topic0s when every member has one", () => {
    const plan = planRequests(slots([filters[5]!, filters[6]!]))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.filter).toEqual({
      address: [SEAPORT_1_6, SEAPORT_1_5, CHIMERA_FACTORY],
      topics: [[NFT_TOPICS.orderFulfilled, NFT_TOPICS.campaignCreated]],
    })
  })

  it("keeps a lone filter exactly as declared and never merges an address-less filter with an address list", () => {
    const plan = planRequests(slots([INKY, ...filters]))
    expect(plan).toHaveLength(5)
    expect(plan[0]!.filter).toBe(INKY)
    expect(planRequests(slots([filters[5]!]))[0]!.filter).toBe(filters[5])
  })

  it("plans nothing for no filters, and skips null slots", () => {
    expect(planRequests([])).toEqual([])
    expect(planRequests(slots([null, filters[0]!, null]))).toHaveLength(1)
  })

  it("keeps filters with different tails apart", () => {
    expect(planRequests(slots([filters[0]!, filters[1]!]))).toHaveLength(2)
  })
})

describe("splitLogs", () => {
  const log = (address: string, topics: string[], blockNumber: bigint, logIndex: number) =>
    ({
      address,
      topics,
      data: "0x",
      blockNumber,
      logIndex,
      blockHash: "0x0",
      transactionHash: "0x0",
    }) as never
  it("gives each member the logs its own filter matches, sorted by block then log index, and drops the rest", () => {
    const [req] = planRequests(slots([filters[1]!, filters[2]!]))
    const a = log("0xa", [T, "0x1", ZERO_TOPIC, "0x9"], 5n, 2)
    const b = log("0xb", [NFT_TOPICS.transferSingle, "0x1", "0x1", ZERO_TOPIC], 3n, 7)
    const c = log("0xc", [NFT_TOPICS.transferSingle, "0x1", ZERO_TOPIC], 5n, 1)
    const stray = log("0xd", [NFT_TOPICS.orderFulfilled, "0x1", ZERO_TOPIC], 5n, 0)
    expect(splitLogs([a, b, c, stray], req!)).toEqual([[a], [c]])
  })
  it("returns a log to every member it matches", () => {
    const both = log("0xa", [T, ZERO_TOPIC, ZERO_TOPIC, "0x9"], 1n, 0)
    const reqs = planRequests(slots([filters[0]!, filters[1]!]))
    expect(reqs.map((r) => splitLogs([both], r))).toEqual([[[both]], [[both]]])
  })
})
