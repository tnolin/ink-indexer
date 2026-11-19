import { ROW_CHUNK } from "../nft/policy"
import type { Tx } from "../source"
import type { NftxBatch, NftxRollback } from "./index"

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

  // One row per (collection, time): of two moves in one block the later row stands, and only over
  // rows this source wrote, never over an OpenSea row.
  for (const r of batch.stats)
    await tx`
      insert into indexer.nft_stats ${tx({
        contract: r.collection,
        at: new Date(r.at * 1000),
        floor_wei: r.floorWei === null ? null : s(r.floorWei),
        owners: r.owners,
        volume_24h_wei: r.volume24hWei,
        sales_24h: r.sales24h,
        total_supply: r.totalSupply,
        floor_market: r.floorMarket,
        os_floor_wei: r.osFloorWei === null ? null : s(r.osFloorWei),
        nftx_floor_wei: s(r.nftxFloorWei),
        pool_count: r.poolCount,
        block: s(r.block),
      })}
      on conflict (contract, at) do update set
        floor_wei = excluded.floor_wei, owners = excluded.owners,
        volume_24h_wei = excluded.volume_24h_wei, sales_24h = excluded.sales_24h,
        total_supply = excluded.total_supply, floor_market = excluded.floor_market,
        os_floor_wei = excluded.os_floor_wei, nftx_floor_wei = excluded.nftx_floor_wei,
        pool_count = excluded.pool_count, block = excluded.block
      where indexer.nft_stats.block is not null`

  // The last announced price and pool size only move forward, so a span that reads old blocks
  // again leaves what a later one wrote.
  for (const l of batch.statsLast)
    await tx`
      update indexer.nftx_collections set
        stats_price_wei = ${s(l.priceWei)}, stats_block = ${s(l.block)},
        pool_count = ${l.poolCount}, pool_count_block = ${s(l.block)}
      where collection = ${l.collection} and (stats_block is null or stats_block <= ${s(l.block)})`
  for (const c of batch.combinedSince)
    await tx`
      update indexer.nftx_collections set combined_since = ${new Date(c.at * 1000)}
      where collection = ${c.collection} and combined_since is null`

  for (const part of chunks(batch.sales))
    await tx`
      insert into indexer.nft_sales ${tx(
        part.map((r) => ({
          tx_hash: r.txHash,
          log_index: r.logIndex,
          contract: r.collection,
          token_id: s(r.tokenId),
          qty: 1,
          price_wei: s(r.priceWei),
          currency: "ETH",
          buyer: r.buyer,
          seller: r.seller,
          order_hash: r.orderHash,
          block: s(r.block),
          market: "nftx",
        })),
      )}
      on conflict do nothing`

  // A filled, relisted, cancelled or stale listing is not listed any more.
  for (const part of chunks(batch.closed))
    await tx`
      delete from indexer.nft_listing_state l
      using unnest(${tx.array(part.map((r) => r.collection))}::text[], ${tx.array(part.map((r) => s(r.tokenId)))}::numeric[]) as ended(contract, token_id)
      where l.contract = ended.contract and l.token_id = ended.token_id`

  // An auction row only moves forward: a phase, once written, stays, and a row another process
  // linked or kept in the meantime stays kept.
  for (const a of batch.auctions) {
    if (a.isNew)
      await tx`
        insert into indexer.nftx_auctions ${tx({
          auction: a.auction,
          token: a.token,
          currency: a.currency,
          start_block: s(a.startBlock),
          end_block: s(a.endBlock),
          claim_block: s(a.claimBlock),
          floor_price_q96: s(a.floorPriceQ96),
          required_raise: s(a.requiredRaise),
          amount: s(a.amount),
          sender: a.sender,
          tx_to: a.txTo,
          created_block: s(a.createdBlock),
          created_log_index: a.createdLogIndex,
        })}
        on conflict (auction) do nothing`
    await tx`
      update indexer.nftx_auctions set
        total_supply = coalesce(total_supply, ${a.totalSupply === null ? null : s(a.totalSupply)}),
        tokens_received_block = coalesce(tokens_received_block, ${a.tokensReceivedBlock === null ? null : s(a.tokensReceivedBlock)}),
        collection = coalesce(collection, ${a.collection}),
        kept = kept or ${a.kept},
        kept_block = coalesce(kept_block, ${a.keptBlock === null ? null : s(a.keptBlock)}),
        created_emitted_block = coalesce(created_emitted_block, ${a.createdEmittedBlock === null ? null : s(a.createdEmittedBlock)}),
        live_block = coalesce(live_block, ${a.liveBlock === null ? null : s(a.liveBlock)}),
        ended_block = coalesce(ended_block, ${a.endedBlock === null ? null : s(a.endedBlock)})
      where auction = ${a.auction}`
  }
  for (const part of chunks(batch.auctionBids))
    await tx`
      insert into indexer.nftx_auction_bids ${tx(
        part.map((b) => ({
          auction: b.auction,
          block: s(b.block),
          log_index: b.logIndex,
          kind: b.kind,
          bid_id: s(b.bidId),
          owner: b.owner,
        })),
      )}
      on conflict do nothing`

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
export async function rollbackRows(tx: Tx, fork: bigint, prepared: NftxRollback) {
  const f = s(fork)
  await tx`delete from indexer.nft_stats where block > ${f}`
  await tx`delete from indexer.nft_sales where market = 'nftx' and block > ${f}`
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
  // Auctions: those created above the fork go, with their bids; a phase written above it is
  // forgotten, so the replay announces it again. An auction kept by a collection created above the
  // fork is unkept, unless it was linked by hand.
  await tx`delete from indexer.nftx_auction_bids where block > ${f}`
  await tx`delete from indexer.nftx_auctions where created_block > ${f}`
  await tx`
    update indexer.nftx_auctions set
      collection = null, kept = false, kept_block = null,
      created_emitted_block = null, live_block = null, ended_block = null
    where kept and not manual and kept_block > ${f}`
  await tx`
    update indexer.nftx_auctions set total_supply = null, tokens_received_block = null
    where tokens_received_block > ${f}`
  await tx`update indexer.nftx_auctions set created_emitted_block = null where created_emitted_block > ${f}`
  await tx`update indexer.nftx_auctions set live_block = null where live_block > ${f}`
  await tx`update indexer.nftx_auctions set ended_block = null where ended_block > ${f}`
  await tx`
    update indexer.nftx_collections set initialized_block = null, pool_id = null,
      fleth_is_currency0 = null, seeded = null
    where initialized_block > ${f}`
  await tx`update indexer.nftx_collections set sunset_block = null where sunset_block > ${f}`
  // The pool size goes back to what it was at the fork, and the last announced price to that of
  // the newest surviving row; with none, the next move announces.
  for (const p of prepared.poolCounts)
    await tx`
      update indexer.nftx_collections set pool_count = ${p.count}, pool_count_block = ${f}
      where collection = ${p.collection} and pool_count_block > ${f}`
  await tx`
    update indexer.nftx_collections set stats_price_wei = null, stats_block = null
    where stats_block > ${f}`
  await tx`
    update indexer.nftx_collections c set stats_price_wei = r.nftx_floor_wei, stats_block = r.block
    from (select distinct on (contract) contract, nftx_floor_wei, block from indexer.nft_stats
          where block is not null order by contract, block desc, at desc) r
    where r.contract = c.collection and c.stats_block is null`
}
