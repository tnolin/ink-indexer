import { describe, expect, it } from "vitest"
import { settleBounded } from "../src/bounded"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("settleBounded", () => {
  it("settles every item in input order whatever order the reads finish in", async () => {
    const items = [0, 1, 2, 3, 4, 5]
    const out = await settleBounded(items, 3, async (i) => {
      await sleep((items.length - i) * 3)
      return i * 10
    })
    expect(out).toEqual(items.map((i) => ({ status: "fulfilled", value: i * 10 })))
  })

  it("never has more than the limit in flight", async () => {
    let now = 0
    let peak = 0
    await settleBounded(
      Array.from({ length: 20 }, (_, i) => i),
      8,
      async () => {
        now++
        peak = Math.max(peak, now)
        await sleep(5)
        now--
      },
    )
    expect(peak).toBe(8)
  })

  it("a limit of 1 reads one item at a time in order", async () => {
    const calls: number[] = []
    const items = [4, 3, 2, 1]
    await settleBounded(items, 1, async (i) => {
      calls.push(i)
      await sleep(1)
    })
    expect(calls).toEqual(items)
  })

  it("a rejected read settles as rejected and the others still run", async () => {
    const out = await settleBounded([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (i) => {
      if (i === 3) throw new Error("boom")
      return i
    })
    expect(out.map((r) => r.status)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i === 3 ? "rejected" : "fulfilled")),
    )
    expect((out[3] as PromiseRejectedResult).reason).toEqual(new Error("boom"))
  })

  it("an empty list makes no call", async () => {
    let calls = 0
    const out = await settleBounded([], 8, async () => {
      calls++
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it("each item is read exactly once", async () => {
    const seen = new Map<number, number>()
    const items = Array.from({ length: 15 }, (_, i) => i)
    await settleBounded(items, 4, async (i) => {
      seen.set(i, (seen.get(i) ?? 0) + 1)
      await sleep(1)
    })
    expect([...seen.values()]).toEqual(items.map(() => 1))
    expect(seen.size).toBe(15)
  })
})
