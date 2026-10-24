# 0020. A per-platform source switch

Date: 2026-10-21
Status: Accepted

## Context

The indexer runs InkyPump, the NFT chain filters and the OpenSea services in one process. Each platform needs to be switchable on its own with a settings edit and a restart.

## Decision

`INDEXER_SOURCES` is a comma-separated list of platform names, trimmed and case-sensitive. Unset or blank enables all of them. An unknown name, a duplicate or an empty entry stops the start with exit code 1 and a message naming the value and the allowed names. The start logs `sources` with the list that runs.

A small table in `apps/indexer/src/wiring.ts` maps each platform to its backfill groups and says whether it needs the OpenSea services:

| Platform | Backfill groups | OpenSea services |
| --- | --- | --- |
| `inkypump` | `inkypump` | no |
| `opensea` | `nft-mints`, `nft-sales` | yes |
| `chimera` | `nft-launches` | no |

The live tick reads only the filters of the enabled groups (`Indexer`'s `only`, the same mechanism as `backfill --sources`), so a disabled group is never fetched. `startNftServices` runs only with `opensea`. With `opensea` on and no `OPENSEA_API_KEY`, the chain NFT filters run and the API services stay off after the existing warning.

`backfill --sources` keeps its explicit list. Without it, backfill covers the groups of the enabled platforms. `mark` is unaffected. A new launchpad adds a row to the table.

## Consequences

- A platform is turned off by editing one variable and restarting. The shared cursor still advances over every block, so turning a platform back on needs a backfill for the range it missed.
- Rows already written stay in the database.
