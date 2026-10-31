import type { Sql } from "@ink-indexer/db"
import { RIPTIDE_VAULT, TSUNAMI_HOOKS, tsunamiLaunchId } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import {
  type CalamariFixtureName,
  loadCalamariFixture,
  loadTsunamiFixture,
  type TsunamiFixture,
  type TsunamiFixtureName,
} from "../../../packages/sdk/test/fixtures"
import type { FakeChain } from "./fake-chain"

export const ETH: Address = "0x0000000000000000000000000000000000000000"

/**
 * Puts a recorded Tsunami transaction into the chain: its logs, its sender and the reads that
 * answer for its tokens (supply and the Riptide vault's balance at the block).
 */
export function addFixture(chain: FakeChain, name: TsunamiFixtureName): TsunamiFixture {
  const f = loadTsunamiFixture(name)
  for (const l of f.logs) chain.add(l)
  const known = chain.senders.get(f.blockNumber)
  const senders = known?.senders ?? new Map()
  senders.set(f.txHash, f.sender)
  chain.senders.set(f.blockNumber, { hash: chain.hashOf(f.blockNumber), senders })
  for (const c of f.curves) {
    chain.supplies.set(c.token, c.totalSupply)
    chain.balances.set(`${c.token}:${RIPTIDE_VAULT}`, c.vaultBalance)
  }
  return f
}

/** A token the source already knows: a tokens row (and its curve state) as an earlier span wrote it. */
export async function seedToken(
  sql: Sql,
  a: {
    curve: Address
    token: Address
    quote?: Address
    supply?: bigint
    targetRaise?: bigint
    createdBlock?: bigint
  },
) {
  await sql`
    insert into indexer.tokens (address, launchpad, hook, launch_id, name, ticker, creator, created_block, created_at,
      quote_asset, total_supply, target_raise, sale_supply, gain_bps)
    values (${a.token}, 'tsunami', ${TSUNAMI_HOOKS.current}, ${tsunamiLaunchId(a.curve)}, 'Seeded', 'SEED',
      '0x00000000000000000000000000000000000000c1', ${(a.createdBlock ?? 1n).toString()}, now(),
      ${a.quote ?? ETH}, ${(a.supply ?? 10n ** 27n).toString()}, ${(a.targetRaise ?? 4_200_000_000_000_000_000n).toString()},
      793100000000000000000000000, null)`
  await sql`
    insert into indexer.curve_state (token, progress_bps, curve_value, target, market_cap, updated_block)
    values (${a.token}, 0, 0, ${(a.targetRaise ?? 4_200_000_000_000_000_000n).toString()}, 0, ${(a.createdBlock ?? 1n).toString()})`
}

/** A recorded Calamari swap transaction: its logs and the sender of its transaction. */
export function addCalamari(chain: FakeChain, name: CalamariFixtureName) {
  const f = loadCalamariFixture(name)
  for (const l of f.logs) chain.add(l)
  const senders = chain.senders.get(f.blockNumber)?.senders ?? new Map()
  for (const [tx, from] of Object.entries(f.senders)) senders.set(tx as Hash, from)
  chain.senders.set(f.blockNumber, { hash: chain.hashOf(f.blockNumber), senders })
  return f
}
