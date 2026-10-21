import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * An OpenSea response recorded by scripts/record-nft-fixtures.ts, by path without `.json`.
 * A file whose name ends in `-handmade` was written by hand from the shape of a live response
 * and is not a recording: it holds only the fields the code reads.
 *
 * (for example "collections/ink-hornet/stats"). REST fixtures are `{ status, body }`; the Stream
 * ones hold frames as received.
 */
export function loadOpenSeaFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "opensea", `${name}.json`), "utf8"),
  )
}
