import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../../..")
const DIRS = ["apps/indexer/test/fixtures", "packages/sdk/test/fixtures"]
// Mirrors the fixture-credential rule in .gitleaks.toml.
const CREDENTIAL = /token=|x-api-key|api[_-]?key|authorization|bearer\s|\/auth\/keys/i

const fixtures = DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f)),
)

describe("recorded fixtures", () => {
  it("are found", () => {
    expect(fixtures.length).toBeGreaterThan(40)
  })

  it("hold no credential or auth exchange", () => {
    const hits = fixtures.filter((f) => CREDENTIAL.test(readFileSync(join(ROOT, f), "utf8")))
    expect(hits).toEqual([])
  })
})
