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
      "usage: main.ts start | backfill --from <block> [--to <block>]",
    )
  })
})
