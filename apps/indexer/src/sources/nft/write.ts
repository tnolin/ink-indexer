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
import { ROW_CHUNK } from "./policy"

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
  // and a launch sets the kind.
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
        launch_token = coalesce(indexer.nft_collections.launch_token, excluded.launch_token)`

  for (const part of chunks(batch.mints.map((t) => transferRecord(t, "recipient"))))
    await tx`insert into indexer.nft_mints ${tx(part)} on conflict do nothing`
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

  // A sold item has no live listing.
  for (const part of chunks(batch.sales))
    await tx`
      delete from indexer.nft_listing_state l
      using unnest(${tx.array(part.map((r) => r.contract))}::text[], ${tx.array(part.map((r) => s(r.tokenId)))}::numeric[]) as sold(contract, token_id)
      where l.contract = sold.contract and l.token_id = sold.token_id`
}

/**
 * Deletes rows above `fork`. A collection whose first mint was above it loses its first-mint
 * fields; one whose launch was above it loses the launchpad, token and kind that launch gave it.
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
    set launchpad = null, launch_token = null, kind = null
    where contract in (select collection from indexer.nft_launches where block > ${f})`
  await tx`delete from indexer.nft_launches where block > ${f}`
  await tx`
    update indexer.nft_collections set first_mint_block = null, first_mint_ts = null
    where first_mint_block > ${f}`
}
