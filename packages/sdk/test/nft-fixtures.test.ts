import { describe, expect, it } from "vitest"
import type { ChainLog } from "../src/index"
import {
  loadFarmWallets,
  loadNftFixture,
  loadSeaportRoles,
  NFT_FIXTURES,
  type NftFixtureName,
} from "./fixtures"

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"
const TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
const ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31"
const ZERO = `0x${"0".repeat(64)}`
const SEADROP = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"

const isErc721 = (l: ChainLog) => l.topics[0] === TRANSFER && l.topics.length === 4
const mints = (logs: ChainLog[], address: string) =>
  logs.filter((l) => l.address === address && isErc721(l) && l.topics[1] === ZERO)
const burns = (logs: ChainLog[], address: string) =>
  logs.filter((l) => l.address === address && isErc721(l) && l.topics[2] === ZERO)
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`

describe("NFT chain fixtures", () => {
  it.each(NFT_FIXTURES)("%s loads as ordered, lowercase chain logs", (name: NftFixtureName) => {
    const logs = loadNftFixture(name)
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(typeof l.blockNumber).toBe("bigint")
      expect(l.address).toBe(l.address.toLowerCase())
      expect(l.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(l.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(Number.isInteger(l.logIndex)).toBe(true)
    }
    const keys = logs.map((l) => `${l.transactionHash}:${l.logIndex}`)
    expect(new Set(keys).size).toBe(logs.length)
    for (let i = 1; i < logs.length; i++) {
      const a = logs[i - 1]!
      const b = logs[i]!
      expect(
        a.blockNumber < b.blockNumber ||
          (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex),
      ).toBe(true)
    }
  })

  it("holds every mint of Hornet, with its SeaDrop mint and config logs", () => {
    const logs = loadNftFixture("hornet-mints")
    expect(mints(logs, HORNET)).toHaveLength(2_222)
    const seaDrop = logs.filter((l) => l.address === SEADROP)
    expect(seaDrop.length).toBeGreaterThan(0)
    for (const l of seaDrop) expect(l.topics[1]).toBe(pad(HORNET))
    // SeaDropMint plus the events that configure the drop, which come before the first mint.
    const kinds = new Set(seaDrop.map((l) => l.topics[0]))
    expect(kinds.size).toBeGreaterThan(1)
    const firstMint = mints(logs, HORNET)[0]!.blockNumber
    expect(seaDrop.some((l) => l.blockNumber < firstMint)).toBe(true)
  })

  it("holds every mint of INKverse, with its SeaDrop logs", () => {
    const logs = loadNftFixture("inkverse-mints")
    expect(mints(logs, INKVERSE)).toHaveLength(1_000)
    const seaDrop = logs.filter((l) => l.address === SEADROP)
    expect(seaDrop.length).toBeGreaterThan(0)
    for (const l of seaDrop) expect(l.topics[1]).toBe(pad(INKVERSE))
  })

  it("holds every PRTSCN mint of 2026-09-09", () => {
    expect(mints(loadNftFixture("prtscn-mints"), PRTSCN)).toHaveLength(4_440)
  })

  it("holds a day of WIRED in which more than 20% of the mints were burned", () => {
    const logs = loadNftFixture("wired-transfers")
    const minted = mints(logs, WIRED).length
    const burned = burns(logs, WIRED).length
    expect(minted).toBeGreaterThan(0)
    expect(burned / minted).toBeGreaterThan(0.2)
    const span = logs.at(-1)!.blockNumber - logs[0]!.blockNumber
    expect(span).toBeLessThan(86_400n)
  })

  it("holds the first two minutes of the burst collection, capped at 3,000 transfers", () => {
    const logs = loadNftFixture("burst-mints")
    const burst = mints(logs, BURST)
    expect(burst).toHaveLength(3_000)
    expect(burst.at(-1)!.blockNumber - burst[0]!.blockNumber).toBeLessThanOrEqual(120n)
    expect(new Set(burst.map((l) => l.topics[3])).size).toBe(3_000)
  })

  it("holds one ERC-1155 mint of each kind", () => {
    const logs = loadNftFixture("erc1155-mints")
    expect(logs.map((l) => l.topics[0]).sort()).toEqual([TRANSFER_BATCH, TRANSFER_SINGLE].sort())
    for (const l of logs) expect(l.topics[2]).toBe(ZERO)
  })

  describe("Seaport fills", () => {
    const logs = loadNftFixture("seaport-fills")
    const roles = loadSeaportRoles()
    const fillsIn = (tx: string) => logs.filter((l) => l.transactionHash === tx)

    it("holds only Seaport OrderFulfilled logs", () => {
      for (const l of logs) {
        expect(l.address).toBe(SEAPORT)
        expect(l.topics[0]).toBe(ORDER_FULFILLED)
      }
    })

    it("holds a sweep transaction with 50 OrderFulfilled logs", () => {
      expect(fillsIn(roles.sweep)).toHaveLength(50)
    })

    it("holds a single listing fill and a single WETH offer fill", () => {
      expect(fillsIn(roles.listing)).toHaveLength(1)
      expect(fillsIn(roles.offer)).toHaveLength(1)
    })

    it("holds a transaction with several NFTs", () => {
      expect(roles.multi).not.toBeNull()
      // `multiIsSingleOrder` says whether one order carried the NFTs. No single order did in the 30
      // days recorded, so the fixture holds a transaction that fills several orders instead.
      const fills = fillsIn(roles.multi!)
      if (roles.multiIsSingleOrder) expect(fills).toHaveLength(1)
      else expect(fills.length).toBeGreaterThanOrEqual(2)
    })

    it("holds a fill paid in an ERC-20 other than WETH", () => {
      // Recorded when one existed in the 30 days before recording; the field is null otherwise.
      expect(roles.unsupportedErc20).not.toBeNull()
      expect(fillsIn(roles.unsupportedErc20!)).toHaveLength(1)
    })
  })

  describe("farm wallets", () => {
    const { farmWallets, ...bursts } = loadFarmWallets()

    it("holds the recipient sets of ten bursts", () => {
      expect(Object.keys(bursts)).toHaveLength(10)
      for (const set of Object.values(bursts)) {
        expect(set.length).toBeGreaterThan(0)
        expect(new Set(set).size).toBe(set.length)
      }
    })

    it("lists exactly the wallets that minted in five or more of them", () => {
      const appearances = new Map<string, number>()
      for (const set of Object.values(bursts))
        for (const w of set) appearances.set(w, (appearances.get(w) ?? 0) + 1)
      const expected = [...appearances].filter(([, n]) => n >= 5).map(([w]) => w)
      expect(farmWallets).toBeDefined()
      expect([...farmWallets!].sort()).toEqual(expected.sort())
      expect(farmWallets!.length).toBeGreaterThan(0)
    })

    it("includes the burst collection among the ten", () => {
      expect(Object.keys(bursts)).toContain(BURST)
    })
  })
})
