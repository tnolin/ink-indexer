import type { Sql } from "@ink-indexer/db"

// `nft:auction <auction> <contract>` links a stored auction to a collection by hand and keeps it,
// for an auction the keep check missed (for example one that sells a token other than the floor
// token). The process entry point is `main.ts auction`.

export const AUCTION_USAGE = "usage: nft:auction <auction> <contract>"

export type AuctionLink = { auction: string; contract: string }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Parses the arguments without touching the database. Both addresses come back lowercase. */
export function parseAuctionLink(
  args: string[],
): ({ ok: true } & AuctionLink) | { ok: false; usage: string; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, usage: AUCTION_USAGE, reason })
  if (args.length !== 2) return bad("expected an auction and a contract")
  const [auction, contract] = args as [string, string]
  if (!ADDRESS.test(auction)) return bad("the auction must be a 0x address")
  if (!ADDRESS.test(contract)) return bad("the contract must be a 0x address")
  return { ok: true, auction: auction.toLowerCase(), contract: contract.toLowerCase() }
}

/**
 * Links the auction to the contract and keeps it. The running indexer reads the kept auctions
 * that still have a phase to announce on every batch, so it announces this one at its next batch
 * without a restart. Throws when the auction is not stored or the contract has no collection row.
 */
export async function applyAuctionLink(sql: Sql, link: AuctionLink): Promise<void> {
  await sql.begin(async (tx) => {
    const stored = await tx`
      select 1 from indexer.nftx_auctions where auction = ${link.auction} for update`
    if (stored.length === 0) throw new Error(`auction ${link.auction} is not stored`)
    const known = await tx`select 1 from indexer.nft_collections where contract = ${link.contract}`
    if (known.length === 0) throw new Error(`no collection row for ${link.contract}`)
    await tx`
      update indexer.nftx_auctions set
        collection = ${link.contract}, kept = true, manual = true, kept_block = null
      where auction = ${link.auction}`
  })
}
