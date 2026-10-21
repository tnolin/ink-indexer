import { describe, expect, it } from "vitest"
import { parseCli } from "../src/cli"

describe("parseCli", () => {
  it("accepts start and backfill with valid arguments", () => {
    expect(parseCli(["start"])).toEqual({ ok: true, command: "start" })
    expect(parseCli(["backfill", "--from", "45252770"])).toEqual({
      ok: true,
      command: "backfill",
      from: 45252770n,
      to: undefined,
    })
    expect(parseCli(["backfill", "--from", "0", "--to", "100"])).toEqual({
      ok: true,
      command: "backfill",
      from: 0n,
      to: 100n,
    })
  })

  it("rejects a missing, empty or malformed --from", () => {
    for (const argv of [
      ["backfill"],
      ["backfill", "--from", ""],
      ["backfill", "--from", "abc"],
      ["backfill", "--from", "-5"],
      ["backfill", "--from", "1.5"],
      ["backfill", "--from", "0x10"],
    ])
      expect(parseCli(argv).ok, argv.join(" ")).toBe(false)
  })

  it("rejects a malformed --to", () => {
    for (const to of ["", "x", "-1", "2e3", "1.0"])
      expect(parseCli(["backfill", "--from", "1", "--to", to]).ok, to).toBe(false)
  })

  it("rejects an unknown flag, an unknown command and no command", () => {
    expect(parseCli(["start", "--bogus"]).ok).toBe(false)
    expect(parseCli(["backfill", "--from", "1", "--nope", "2"]).ok).toBe(false)
    expect(parseCli(["restart"]).ok).toBe(false)
    expect(parseCli([]).ok).toBe(false)
  })

  it("carries the usage line with every rejection", () => {
    const r = parseCli(["backfill"])
    expect(r.ok === false && r.usage).toBe(
      "usage: main.ts start | backfill --from <block> [--to <block>] [--sources <names>] | mark <contract> <mark>",
    )
  })

  it("parses --sources and rejects unknown names", () => {
    expect(
      parseCli([
        "backfill",
        "--from",
        "1",
        "--sources",
        "inkypump,nft-mints,nft-sales,nft-launches",
      ]),
    ).toEqual({
      ok: true,
      command: "backfill",
      from: 1n,
      to: undefined,
      sources: ["inkypump", "nft-mints", "nft-sales", "nft-launches"],
    })
    expect(parseCli(["backfill", "--from", "1", "--sources", " nft-sales , nft-sales"])).toEqual({
      ok: true,
      command: "backfill",
      from: 1n,
      to: undefined,
      sources: ["nft-sales"],
    })
    for (const sources of ["", ",", "nft", "nft-mints,opensea", "NFT-SALES", "nft-sales,"]) {
      const r = parseCli(["backfill", "--from", "1", "--sources", sources])
      expect(r.ok, sources).toBe(false)
    }
    const r = parseCli(["backfill", "--from", "1", "--sources", "nft-mints,opensea"])
    expect(r.ok === false && r.reason).toBe(
      "unknown source: opensea (expected inkypump, nft-mints, nft-sales, nft-launches)",
    )
    expect(parseCli(["start", "--sources", "nft-sales"]).ok).toBe(false)
  })
})

describe("parseCli mark", () => {
  const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"

  it("nft:mark validates the address and value", () => {
    expect(parseCli(["mark", HORNET.toUpperCase().replace("0X", "0x"), "filtered"])).toEqual({
      ok: true,
      command: "mark",
      contract: HORNET,
      value: "filtered",
    })
    for (const value of ["real", "filtered", "continuous", "drop", "clear"])
      expect(parseCli(["mark", HORNET, value])).toMatchObject({ ok: true, value })
    for (const argv of [
      ["mark"],
      ["mark", HORNET],
      ["mark", HORNET, "spam"],
      ["mark", HORNET, "Real"],
      ["mark", "0x1234", "real"],
      ["mark", `${HORNET}00`, "real"],
      ["mark", HORNET.slice(2), "real"],
      ["mark", HORNET, "real", "extra"],
      ["mark", HORNET, "real", "--from", "1"],
    ])
      expect(parseCli(argv).ok, argv.join(" ")).toBe(false)
    const r = parseCli(["mark", HORNET, "spam"])
    expect(r.ok === false && r.usage).toBe(
      "usage: nft:mark <contract> <real|filtered|continuous|drop|clear>",
    )
  })
})
