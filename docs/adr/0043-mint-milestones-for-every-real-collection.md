# 0043. Mint milestones for every real collection

Date: 2026-11-19
Status: Accepted

## Context

Mint progress events (`nft.mint` with `kind: "progress"` at 25%, 50% and 75%, and `sold_out`) came from SeaDrop's own configuration and mint stats. A collection that mints through its own contract, as most NFTX and Chimera collections do, never reached them, and a collection whose contract does not report a max supply could not be measured at all.

## Decision

**The indexer's own mint count drives the milestones.** A collection judged or marked `real` that is not a SeaDrop drop gets progress and sold-out events from the mints the source has stored, as one stage named `Mint`. A collection marked `real` by hand gets a stage start after 10 mints, as a verified collection with no SeaDrop stages does. A contract that had items minted before its first stored mint still gets only `sold_out`, as before ([ADR 0027](0027-no-mint-events-for-prior-supply.md)).

**Mints into the NFTX Locker do not count.** A mint to the Locker, or to a wallet that deposits the token there in the same transaction, is not stored (see [ADR 0041](0041-nftx-source.md)), so a collection's deposits never advance its milestones or make a wallet a minting wallet.

**A max supply can be set by hand.** `pnpm nft:mark <contract> <mark> --max-supply <n>` stores a max supply in `nft_overrides`. It wins over the contract's own answer in the verdict job and in SeaDrop milestones. `nft:mark <contract> clear` forgets it, and the next verdict run reads the contract again.

## Consequences

- Progress events exist for every collection that is judged real, whatever it mints through.
- A wrong max supply from a contract can be corrected without touching code, and the correction is undone by `clear`.
