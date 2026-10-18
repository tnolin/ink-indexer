import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * An OpenSea response recorded by scripts/record-nft-fixtures.ts, by path without `.json`
 * (for example "collections/ink-hornet/stats"). REST fixtures are `{ status, body }`; the Stream
 * ones hold frames as received.
 */
export function loadOpenSeaFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "opensea", `${name}.json`), "utf8"),
  )
}
