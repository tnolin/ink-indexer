import {
  CallExecutionError,
  ExecutionRevertedError,
  encodeAbiParameters,
  type Hex,
  HttpRequestError,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  type CodeReader,
  hasCodeAt,
  NFT_SELECTORS,
  type NftReader,
  readChimeraSupply,
  readMaxSupply,
  readMintStats,
  readNftTotalSupply,
} from "../src/index"

const CONTRACT = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const MINTER = "0x00000000000000000000000000000000000a11ce"

const words = (...n: bigint[]) =>
  encodeAbiParameters(
    n.map(() => ({ type: "uint256" as const })),
    n,
  )
const revert = () =>
  new CallExecutionError(new ExecutionRevertedError({ message: "execution reverted" }), {})

type Call = { to?: string; data?: Hex; blockNumber?: bigint }
/** A client whose `call` answers from a queue, recording what it was asked. */
function stub(...answers: (Hex | Error)[]) {
  const calls: Call[] = []
  const client = {
    call: async (p: Call) => {
      calls.push(p)
      const a = answers.shift()
      if (a instanceof Error) throw a
      return { data: a }
    },
  } as unknown as NftReader
  return { client, calls }
}

describe("readMintStats", () => {
  it("returns the second and third words", async () => {
    const { client, calls } = stub(words(7n, 1_234n, 2_222n))
    expect(await readMintStats(client, CONTRACT, MINTER, 99n)).toEqual({
      totalSupply: 1_234n,
      maxSupply: 2_222n,
    })
    expect(calls).toEqual([
      {
        to: CONTRACT,
        data: `${NFT_SELECTORS.getMintStats}${"0".repeat(24)}${MINTER.slice(2)}`,
        blockNumber: 99n,
      },
    ])
  })

  it("returns null on revert", async () => {
    expect(await readMintStats(stub(revert()).client, CONTRACT, MINTER, 99n)).toBeNull()
  })

  it("returns null when the answer is empty or short", async () => {
    expect(await readMintStats(stub("0x").client, CONTRACT, MINTER, 99n)).toBeNull()
    expect(await readMintStats(stub(words(1n, 2n)).client, CONTRACT, MINTER, 99n)).toBeNull()
  })

  it("lets a transport failure through rather than reporting a revert", async () => {
    const down = new CallExecutionError(
      new HttpRequestError({ url: "http://rpc.invalid", status: 503 }),
      {},
    )
    await expect(readMintStats(stub(down).client, CONTRACT, MINTER, 99n)).rejects.toThrow()
  })
})

describe("readMaxSupply", () => {
  it("reads maxSupply() first", async () => {
    const { client, calls } = stub(words(2_222n))
    expect(await readMaxSupply(client, CONTRACT, 99n)).toBe(2_222n)
    expect(calls).toEqual([{ to: CONTRACT, data: NFT_SELECTORS.maxSupply, blockNumber: 99n }])
  })

  it("falls back to MAX_SUPPLY()", async () => {
    const { client, calls } = stub(revert(), words(555n))
    expect(await readMaxSupply(client, CONTRACT, 99n)).toBe(555n)
    expect(calls.map((c) => c.data)).toEqual([NFT_SELECTORS.maxSupply, NFT_SELECTORS.MAX_SUPPLY])
  })

  it("falls back on an empty answer too", async () => {
    expect(await readMaxSupply(stub("0x", words(9n)).client, CONTRACT, 99n)).toBe(9n)
  })

  it("returns null when neither exists", async () => {
    expect(await readMaxSupply(stub(revert(), revert()).client, CONTRACT, 99n)).toBeNull()
  })
})

describe("readNftTotalSupply", () => {
  it("reads totalSupply() at a block", async () => {
    const { client, calls } = stub(words(100n))
    expect(await readNftTotalSupply(client, CONTRACT, 99n)).toBe(100n)
    expect(calls).toEqual([{ to: CONTRACT, data: NFT_SELECTORS.totalSupply, blockNumber: 99n }])
  })

  it("returns null when it reverts or answers nothing", async () => {
    expect(await readNftTotalSupply(stub(revert()).client, CONTRACT, 99n)).toBeNull()
    expect(await readNftTotalSupply(stub("0x").client, CONTRACT, 99n)).toBeNull()
  })
})

describe("readChimeraSupply", () => {
  it("reads permanentSupply() and maxPermanent() at the latest block", async () => {
    const { client, calls } = stub(words(729n), words(999n))
    expect(await readChimeraSupply(client, CONTRACT)).toEqual({
      permanentSupply: 729n,
      maxPermanent: 999n,
    })
    expect(calls).toEqual([
      { to: CONTRACT, data: NFT_SELECTORS.permanentSupply, blockNumber: undefined },
      { to: CONTRACT, data: NFT_SELECTORS.maxPermanent, blockNumber: undefined },
    ])
  })

  it("reads at a block when given one", async () => {
    const { client, calls } = stub(words(1n), words(2n))
    await readChimeraSupply(client, CONTRACT, 99n)
    expect(calls.map((c) => c.blockNumber)).toEqual([99n, 99n])
  })

  it("returns null when either read reverts or answers nothing", async () => {
    expect(await readChimeraSupply(stub(revert(), words(9n)).client, CONTRACT)).toBeNull()
    expect(await readChimeraSupply(stub(words(9n), revert()).client, CONTRACT)).toBeNull()
    expect(await readChimeraSupply(stub("0x", words(9n)).client, CONTRACT)).toBeNull()
  })
})

describe("hasCodeAt", () => {
  const code = (answer: Hex | undefined) => {
    const asked: unknown[] = []
    const client = {
      getCode: async (p: unknown) => {
        asked.push(p)
        return answer
      },
    } as unknown as CodeReader
    return { client, asked }
  }

  it("is true when the address had code at the block", async () => {
    const { client, asked } = code("0x6080")
    expect(await hasCodeAt(client, CONTRACT, 99n)).toBe(true)
    expect(asked).toEqual([{ address: CONTRACT, blockNumber: 99n }])
  })

  it("is false for no code", async () => {
    expect(await hasCodeAt(code(undefined).client, CONTRACT, 99n)).toBe(false)
    expect(await hasCodeAt(code("0x").client, CONTRACT, 99n)).toBe(false)
  })
})
