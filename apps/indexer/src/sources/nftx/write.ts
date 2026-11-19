import { ROW_CHUNK } from "../nft/policy"
import type { Tx } from "../source"
import type { NftxBatch } from "./index"

// The NFTX source's tables, written inside the loop's transaction.

const s = (x: bigint) => x.toString()
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += ROW_CHUNK) yield rows.slice(i, i + ROW_CHUNK)
}

export async function writeRows(tx: Tx, batch: NftxBatch) {
  for (const c of batch.created) {
    await tx`
      insert into indexer.nftx_collections ${tx({
        collection: c.collection,
        floor_token: c.floorToken,
        creator: c.creator,
        name: c.name,
        symbol: c.symbol,
        created_block: s(c.block),
        launchpad_created: c.launchpadCreated,
      })}
      on conflict (collection) do nothing`
    // `launchpad` and the floor token are filled only while the collection has no launchpad, so a
    // Chimera launch keeps both. Creating a collection marks its verdict dirty. The Locker takes
    // ERC-721 collections (its events name token ids with no amounts), and a collection nobody
    // minted since the indexer's history began has no mint to tell its standard from.
    await tx`
      insert into indexer.nft_collections ${tx({
        contract: c.collection,
        standard: "erc721",
        launchpad: "nftx",
        launch_token: c.floorToken,
        verdict_dirty: true,
      })}
      on conflict (contract) do update set
        standard = coalesce(indexer.nft_collections.standard, excluded.standard),
        launch_token = case
          when indexer.nft_collections.launchpad is null then excluded.launch_token
          else indexer.nft_collections.launch_token end,
        launchpad = coalesce(indexer.nft_collections.launchpad, excluded.launchpad),
        verdict_dirty = true`
    if (c.launchpadCreated)
      // A mark made by hand stays.
      await tx`
        insert into indexer.nft_overrides ${tx({
          contract: c.collection,
          verdict: "real",
          note: "nftx-launchpad",
          set_at: new Date(),
        })}
        on conflict (contract) do nothing`
  }

  for (const o of batch.opened) {
    await tx`
      update indexer.nftx_collections set
        initialized_block = ${s(o.block)}, pool_id = ${o.poolId},
        fleth_is_currency0 = ${o.flethIsCurrency0}, seeded = ${o.seeded}
      where collection = ${o.collection}
        and (initialized_block is null or initialized_block = ${s(o.block)})`
    if (o.launch)
      await tx`
        insert into indexer.nft_launches ${tx({
          collection: o.collection,
          launchpad: "nftx",
          token: o.launch.token,
          pool_id: o.poolId,
          creator: o.launch.creator,
          block: s(o.block),
        })}
        on conflict do nothing`
    await tx`update indexer.nft_collections set verdict_dirty = true where contract = ${o.collection}`
  }

  for (const part of chunks(batch.prices))
    await tx`
      insert into indexer.nftx_prices ${tx(
        part.map((p) => ({
          collection: p.collection,
          block: s(p.block),
          log_index: p.logIndex,
          sqrt_price_x96: s(p.sqrtPriceX96),
          price_wei: p.priceWei === null ? null : s(p.priceWei),
          at: new Date(p.at * 1000),
        })),
      )}
      on conflict do nothing`

  for (const x of batch.sunsets)
    await tx`
      update indexer.nftx_collections set sunset_block = ${s(x.block)}
      where collection = ${x.collection} and (sunset_block is null or sunset_block = ${s(x.block)})`

  for (const x of batch.slugs)
    await tx`
      update indexer.nft_collections set nftx_slug = ${x.slug}
      where contract = ${x.collection} and nftx_slug is null`
}

/**
 * Deletes rows above `fork`. A collection created above it is removed, and the launchpad and floor
 * token it gave `nft_collections` go with it, but only while it is still the collection's launchpad:
 * a collection a Chimera launch claimed keeps that launch.
 */
export async function rollbackRows(tx: Tx, fork: bigint) {
  const f = s(fork)
  await tx`delete from indexer.nftx_prices where block > ${f}`
  await tx`delete from indexer.nft_launches where launchpad = 'nftx' and block > ${f}`
  await tx`
    update indexer.nft_collections set launchpad = null, launch_token = null, verdict_dirty = true
    where launchpad = 'nftx'
      and contract in (select collection from indexer.nftx_collections where created_block > ${f})`
  await tx`
    delete from indexer.nft_overrides
    where note = 'nftx-launchpad'
      and contract in (select collection from indexer.nftx_collections where created_block > ${f})`
  await tx`delete from indexer.nftx_collections where created_block > ${f}`
  await tx`
    update indexer.nftx_collections set initialized_block = null, pool_id = null,
      fleth_is_currency0 = null, seeded = null
    where initialized_block > ${f}`
  await tx`update indexer.nftx_collections set sunset_block = null where sunset_block > ${f}`
}
