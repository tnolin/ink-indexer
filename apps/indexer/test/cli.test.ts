import { describe, expect, it } from "vitest"
import { parseCli } from "../src/cli"
import { MARK_USAGE, parseMark } from "../src/mark-cli"

describe("parseCli", () => {
  it("accepts start and backfill with valid arguments", () => {
    expect(parseCli(["start"])).toEqual({ ok: true, command: "start" })
    expect(parseCli(["collections-from-sales"])).toEqual({
      ok: true,
      command: "collections-from-sales",
    })
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

  it("collections-from-sales takes no options", () => {
    expect(parseCli(["collections-from-sales", "--from", "1"])).toMatchObject({ ok: false })
  })

  it("carries the usage line with every rejection", () => {
    const r = parseCli(["backfill"])
    expect(r.ok === false && r.usage).toBe(
      "usage: main.ts start | backfill --from <block> [--to <block>] [--sources <names>] [--block-reads <1-16>] | mark <contract> <mark> [--max-supply <n>] | auction <auction> <contract> | quarantine clear <source> | collections-from-sales",
    )
  })

  it("parses --sources and rejects unknown names", () => {
    expect(
      parseCli([
        "backfill",
        "--from",
        "1",
        "--sources",
        "inkypump,v4-swaps,nft-mints,nft-sales,nft-launches",
      ]),
    ).toEqual({
      ok: true,
      command: "backfill",
      from: 1n,
      to: undefined,
      sources: ["inkypump", "v4-swaps", "nft-mints", "nft-sales", "nft-launches"],
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
      "unknown source: opensea (expected inkypump, inkfun, tsunami, hookit, v4-swaps, nft-mints, nft-sales, nft-launches, nftx)",
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
      "usage: nft:mark <contract> <real|filtered|continuous|drop|clear> [--max-supply <n>]",
    )
  })

  it("parseCli mark 0x… real --max-supply 3333 returns maxSupply 3333n", () => {
    expect(parseCli(["mark", HORNET, "real", "--max-supply", "3333"])).toEqual({
      ok: true,
      command: "mark",
      contract: HORNET,
      value: "real",
      maxSupply: 3333n,
    })
    // Without the flag the result has no maxSupply field at all.
    expect("maxSupply" in (parseCli(["mark", HORNET, "real"]) as object)).toBe(false)
  })

  it("parseMark accepts --max-supply 3333 after the value", () => {
    expect(parseMark([HORNET, "drop", "--max-supply", "3333"])).toEqual({
      ok: true,
      contract: HORNET,
      value: "drop",
      maxSupply: 3333n,
    })
    const widest = "9".repeat(78)
    expect(parseMark([HORNET, "real", "--max-supply", widest])).toMatchObject({
      ok: true,
      maxSupply: BigInt(widest),
    })
    expect(MARK_USAGE).toContain("[--max-supply <n>]")
  })

  it("refuses --max-supply 0, -1, 1e3, a 79-digit number, a repeated flag and clear with --max-supply", () => {
    for (const argv of [
      [HORNET, "real", "--max-supply", "0"],
      [HORNET, "real", "--max-supply", "000"],
      [HORNET, "real", "--max-supply", "-1"],
      [HORNET, "real", "--max-supply", "1e3"],
      [HORNET, "real", "--max-supply", "1.5"],
      [HORNET, "real", "--max-supply", "0x10"],
      [HORNET, "real", "--max-supply", "9".repeat(79)],
      [HORNET, "real", "--max-supply", ""],
      [HORNET, "real", "--max-supply"],
      [HORNET, "real", "--max-supply", "5", "--max-supply", "6"],
      [HORNET, "clear", "--max-supply", "5"],
      [HORNET, "--max-supply", "5", "real"],
      [HORNET, "real", "--max-supply", "5", "extra"],
    ])
      expect(parseMark(argv).ok, argv.join(" ")).toBe(false)
  })

  it("--block-reads takes 1 to 16 on a backfill, and is left out by default", () => {
    expect(parseCli(["backfill", "--from", "1"])).toMatchObject({ blockReads: undefined })
    for (const n of [1, 8, 16])
      expect(parseCli(["backfill", "--from", "1", "--block-reads", String(n)])).toEqual({
        ok: true,
        command: "backfill",
        from: 1n,
        to: undefined,
        sources: undefined,
        blockReads: n,
      })
    for (const n of ["0", "17", "x", "", "-1", "2.5", "08", "1e1"])
      expect(parseCli(["backfill", "--from", "1", "--block-reads", n]).ok, n).toBe(false)
  })

  it("cli: backfill without --block-reads leaves blockReads undefined, so the default of 4 applies", () => {
    const r = parseCli(["backfill", "--from", "1"])
    expect(r.ok && "blockReads" in r && r.blockReads).toBeUndefined()
  })

  it("--block-reads is not an option of the other commands", () => {
    for (const command of ["start", "collections-from-sales"])
      expect(parseCli([command, "--block-reads", "4"]).ok, command).toBe(false)
  })

  it("the usage line names --block-reads", () => {
    const r = parseCli(["backfill"])
    expect(r.ok === false && r.usage).toContain("[--block-reads <1-16>]")
  })
})

describe("parseCli auction", () => {
  const A = "0xf74d83a782aa45ec00d4f425714c028749a03563"
  const C = "0x0000000000000000000000000000000000000c0c"

  it("nft:auction takes an auction and a contract", () => {
    expect(parseCli(["auction", A, C])).toEqual({
      ok: true,
      command: "auction",
      auction: A,
      contract: C,
    })
    for (const argv of [
      ["auction"],
      ["auction", A],
      ["auction", A, C, C],
      ["auction", A, "0x12"],
    ]) {
      const r = parseCli(argv)
      expect(r.ok, argv.join(" ")).toBe(false)
      expect(r.ok === false && r.usage).toContain("auction <auction> <contract>")
    }
  })
})

describe("parseCli quarantine", () => {
  const ALLOWED = "inkypump, inkfun, tsunami, hookit, v4, nft, nftx"

  it("quarantine clear nft parses", () => {
    expect(parseCli(["quarantine", "clear", "nft"])).toEqual({
      ok: true,
      command: "quarantine",
      source: "nft",
    })
  })

  it("quarantine clear with an unknown, upper-case, padded or empty name is refused, naming the allowed sources", () => {
    for (const name of ["nope", "NFT", " nft", "nft ", ""]) {
      const r = parseCli(["quarantine", "clear", name])
      expect(r.ok, JSON.stringify(name)).toBe(false)
      expect(r.ok === false && r.usage).toContain("quarantine clear <source>")
      expect(r.ok === false && r.reason).toContain(ALLOWED)
    }
  })

  it("quarantine with no subcommand, another subcommand or an extra argument is refused", () => {
    for (const argv of [
      ["quarantine"],
      ["quarantine", "list"],
      ["quarantine", "clear"],
      ["quarantine", "clear", "nft", "nft"],
      ["quarantine", "nft"],
    ]) {
      const r = parseCli(argv)
      expect(r.ok, argv.join(" ")).toBe(false)
      expect(r.ok === false && r.usage).toContain("quarantine clear <source>")
    }
  })

  it("a quarantine name that is a group (v4-swaps) is refused", () => {
    for (const name of ["v4-swaps", "nft-mints", "nft-sales", "nft-launches"])
      expect(parseCli(["quarantine", "clear", name]).ok, name).toBe(false)
  })
})
