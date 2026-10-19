import type { Tx } from "../source"
import type {
  CollectionTouch,
  LaunchRow,
  NftBatch,
  SaleRow,
  SeaDropConfigRow,
  SeaDropMintRow,
  TransferRow,
} from "./index"
import { DISCOVERY_RESTART_MS, DISCOVERY_RETRY_MS, DROPS_DEBOUNCE_MS, ROW_CHUNK } from "./policy"

// The NFT source's tables, written inside the loop's transaction.

const s = (x: bigint) => x.toString()
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += ROW_CHUNK) yield rows.slice(i, i + ROW_CHUNK)
}

const collectionRecord = (c: CollectionTouch) => ({
  contract: c.contract,
  standard: c.standard,
  first_mint_block: c.firstMint ? s(c.firstMint.block) : null,
  first_mint_ts: c.firstMint ? new Date(c.firstMint.ts * 1000) : null,
  seadrop: c.seadrop,
  kind: c.launch ? "continuous" : null,
  launchpad: c.launch?.launchpad ?? null,
  launch_token: c.launch?.token ?? null,
  creator_address: c.launch?.creator ?? null,
})

const transferRecord = (t: TransferRow, holder: "recipient" | "holder") => ({
  tx_hash: t.txHash,
  log_index: t.logIndex,
  idx: t.idx,
  contract: t.contract,
  token_id: s(t.tokenId),
  [holder]: t.account,
  qty: s(t.qty),
  block: s(t.block),
})

const seadropMintRecord = (m: SeaDropMintRow) => ({
  tx_hash: m.txHash,
  log_index: m.logIndex,
  contract: m.contract,
  minter: m.minter,
  payer: m.payer,
  qty: s(m.qty),
  unit_price: s(m.unitPrice),
  stage: m.stage,
  block: s(m.block),
})

const saleRecord = (r: SaleRow) => ({
  tx_hash: r.txHash,
  log_index: r.logIndex,
  contract: r.contract,
  token_id: s(r.tokenId),
  qty: s(r.qty),
  price_wei: s(r.priceWei),
  currency: r.currency,
  buyer: r.buyer,
  seller: r.seller,
  order_hash: r.orderHash,
  block: s(r.block),
})

const launchRecord = (l: LaunchRow) => ({
  collection: l.collection,
  launchpad: l.launchpad,
  campaign_id: s(l.campaignId),
  token: l.token,
  core: l.core,
  pool_id: l.poolId,
  rewards: l.rewards,
  vault: l.vault,
  creator: l.creator,
  block: s(l.block),
})

/** Raw rows, collections, launches and the listing state of sold items. Events are the store's. */
export async function writeRows(tx: Tx, batch: NftBatch) {
  // Collections first: the first mint is the earliest block seen, a SeaDrop flag stays once set,
  // and a launch sets the kind. A new first mint or a launch marks the verdict dirty.
  for (const part of chunks(batch.collections.map(collectionRecord)))
    await tx`
      insert into indexer.nft_collections ${tx(part)}
      on conflict (contract) do update set
        standard = coalesce(indexer.nft_collections.standard, excluded.standard),
        first_mint_block = case
          when excluded.first_mint_block is not null
            and (indexer.nft_collections.first_mint_block is null
              or excluded.first_mint_block < indexer.nft_collections.first_mint_block)
          then excluded.first_mint_block else indexer.nft_collections.first_mint_block end,
        first_mint_ts = case
          when excluded.first_mint_block is not null
            and (indexer.nft_collections.first_mint_block is null
              or excluded.first_mint_block < indexer.nft_collections.first_mint_block)
          then excluded.first_mint_ts else indexer.nft_collections.first_mint_ts end,
        seadrop = indexer.nft_collections.seadrop or excluded.seadrop,
        kind = coalesce(excluded.kind, indexer.nft_collections.kind),
        launchpad = coalesce(excluded.launchpad, indexer.nft_collections.launchpad),
        launch_token = coalesce(indexer.nft_collections.launch_token, excluded.launch_token),
        creator_address = coalesce(indexer.nft_collections.creator_address, excluded.creator_address),
        verdict_dirty = indexer.nft_collections.verdict_dirty
          or excluded.launchpad is not null
          or (excluded.first_mint_block is not null
            and (indexer.nft_collections.first_mint_block is null
              or excluded.first_mint_block < indexer.nft_collections.first_mint_block))`

  // OpenSea triggers. A new row is due for discovery by its column default. New activity on a
  // contract with no slug restarts discovery: the failures are forgotten, and the next lookup is
  // at most five minutes away (at once if it had given up). That happens at most once a day per
  // contract, so a contract OpenSea never lists is not asked about for good by its own mints. A
  // SeaDrop configuration log makes the drop page due soon, unless it is already due sooner.
  const active = [
    ...new Set([...batch.mints.map((m) => m.contract), ...batch.sales.map((r) => r.contract)]),
  ]
  if (active.length > 0)
    await tx`
      update indexer.nft_collections set
        discovery_attempts = 0,
        attempts_reset_at = now(),
        -- A failed gate 1 waits on discovery again.
        verdict_dirty = true,
        next_discovery_at = least(coalesce(next_discovery_at, now()), now() + make_interval(secs => ${DISCOVERY_RETRY_MS[0] / 1000}::float8))
      where contract = any(${tx.array(active)}::text[]) and slug is null
        and (discovery_attempts > 0 or next_discovery_at is null)
        and (attempts_reset_at is null
          or attempts_reset_at <= now() - make_interval(secs => ${DISCOVERY_RESTART_MS / 1000}::float8))`
  const configured = [...new Set(batch.seadropConfig.map((c) => c.contract))]
  if (configured.length > 0)
    await tx`
      update indexer.nft_collections set
        next_drops_at = least(coalesce(next_drops_at, 'infinity'::timestamptz), now() + make_interval(secs => ${DROPS_DEBOUNCE_MS / 1000}::float8))
      where contract = any(${tx.array(configured)}::text[])`

  for (const part of chunks(batch.mints.map((t) => transferRecord(t, "recipient"))))
    await tx`insert into indexer.nft_mints ${tx(part)} on conflict do nothing`
  // A verified collection's (or creator's) drop with no SeaDrop stages is announced after its
  // first few mints, so each new mint has the verdict job look until it has been. Other kinds get
  // no such announcement.
  const minted = [...new Set(batch.mints.map((m) => m.contract))]
  if (minted.length > 0)
    await tx`
      update indexer.nft_collections c set verdict_dirty = true
      where c.contract = any(${tx.array(minted)}::text[])
        and not c.verdict_dirty and not c.seadrop and not c.mint_start_emitted
        and (c.kind is null or c.kind = 'drop')
        and (c.safelist = 'verified' or exists (
          select 1 from indexer.nft_accounts a
          where a.address = coalesce(c.creator_address, c.owner) and a.verified))`
  for (const part of chunks(batch.burns.map((t) => transferRecord(t, "holder"))))
    await tx`insert into indexer.nft_burns ${tx(part)} on conflict do nothing`
  for (const part of chunks(batch.seadropMints.map(seadropMintRecord)))
    await tx`insert into indexer.nft_seadrop_mints ${tx(part)} on conflict do nothing`
  const config = (c: SeaDropConfigRow) => ({
    tx_hash: c.txHash,
    log_index: c.logIndex,
    contract: c.contract,
    event: c.event,
    fields: tx.json(c.fields),
    block: s(c.block),
  })
  for (const part of chunks(batch.seadropConfig.map(config)))
    await tx`insert into indexer.nft_seadrop_config ${tx(part)} on conflict do nothing`
  for (const part of chunks(batch.sales.map(saleRecord)))
    await tx`insert into indexer.nft_sales ${tx(part)} on conflict do nothing`
  for (const part of chunks(batch.launches.map(launchRecord)))
    await tx`insert into indexer.nft_launches ${tx(part)} on conflict do nothing`

  // Milestones: stages first seen, and where each contract's marks and sell-out stand. A new mark
  // or the sell-out marks the verdict dirty (gate 4 is looked at again at every mark).
  const stage = (r: NftBatch["stages"][number]) => ({
    contract: r.contract,
    stage_index: r.index,
    first_block: s(r.block),
    first_ts: new Date(r.ts * 1000),
  })
  for (const part of chunks(batch.stages.map(stage)))
    await tx`insert into indexer.nft_stages ${tx(part)} on conflict do nothing`
  for (const m of batch.milestones)
    await tx`
      update indexer.nft_collections set
        max_supply = ${s(m.maxSupply)},
        last_mark_bps = greatest(last_mark_bps, ${m.lastMarkBps}),
        sold_out_block = coalesce(sold_out_block, ${m.soldOutBlock === null ? null : s(m.soldOutBlock)}),
        verdict_dirty = verdict_dirty or ${m.lastMarkBps} > last_mark_bps
          or (sold_out_block is null and ${m.soldOutBlock !== null})
      where contract = ${m.contract}`

  // A sold item has no live listing.
  for (const part of chunks(batch.sales))
    await tx`
      delete from indexer.nft_listing_state l
      using unnest(${tx.array(part.map((r) => r.contract))}::text[], ${tx.array(part.map((r) => s(r.tokenId)))}::numeric[]) as sold(contract, token_id)
      where l.contract = sold.contract and l.token_id = sold.token_id`
}

/**
 * Deletes rows above `fork`. A collection whose first mint was above it loses its first-mint
 * fields; one whose launch was above it loses the launchpad, token, creator and kind that launch gave it.
 *
 * shortcut: a collection whose only logs were above the fork keeps its row, `standard` and
 * `seadrop = true`. Deleting it would need a first-seen block column on nft_collections.
 */
export async function rollbackRows(tx: Tx, fork: bigint) {
  const f = s(fork)
  await tx`delete from indexer.nft_mints where block > ${f}`
  await tx`delete from indexer.nft_burns where block > ${f}`
  await tx`delete from indexer.nft_seadrop_mints where block > ${f}`
  await tx`delete from indexer.nft_seadrop_config where block > ${f}`
  await tx`delete from indexer.nft_sales where block > ${f}`
  await tx`
    update indexer.nft_collections
    set launchpad = null, launch_token = null, creator_address = null, kind = null,
      verdict_dirty = true
    where contract in (select collection from indexer.nft_launches where block > ${f})`
  await tx`delete from indexer.nft_launches where block > ${f}`
  await tx`
    update indexer.nft_collections set first_mint_block = null, first_mint_ts = null,
      prior_supply = null, prior_minted = null, verdict_dirty = true
    where first_mint_block > ${f}`

  // Stages first seen above the fork start again on replay. A collection's marks and sell-out
  // stand where the surviving `nft.mint` events leave them (the loop already deleted the rest).
  await tx`delete from indexer.nft_stages where first_block > ${f}`
  await tx`
    update indexer.nft_collections c set
      last_mark_bps = coalesce((
        select max((e.payload->>'markBps')::int) from indexer.events e
        where e.type = 'nft.mint' and e.entity = c.contract and e.payload->>'kind' = 'progress'), 0),
      sold_out_block = (
        select min(e.block) from indexer.events e
        where e.type = 'nft.mint' and e.entity = c.contract and e.payload->>'kind' = 'sold_out')
    where c.last_mark_bps > 0 or c.sold_out_block is not null`
}
