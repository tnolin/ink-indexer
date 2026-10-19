import type { Sql } from "@ink-indexer/db"
import { type OsAccount, parseAccount } from "@ink-indexer/sdk"
import { ACCOUNT_REFRESH_MS } from "../nft/policy"
import type { OpenSeaRest, OsResult } from "./rest"
import { OS_REQUEST } from "./scheduler"

export type Account = OsAccount

export type Accounts = {
  /**
   * The OpenSea account of an address: the cached row while it is under seven days old, else read
   * from `GET /accounts/{address}` and cached. An address OpenSea has no account for is cached as
   * no username, not verified. Any other failure is returned and nothing is cached. Never throws
   * for a failed request.
   */
  getAccount(address: string): Promise<OsResult<Account>>
}

export function createAccounts(deps: {
  sql: Sql
  rest: OpenSeaRest
  now?: () => number
}): Accounts {
  const { sql, rest } = deps
  const now = deps.now ?? Date.now

  async function save(address: string, a: Account): Promise<void> {
    await sql`
      insert into indexer.nft_accounts (address, username, verified, fetched_at)
      values (${address}, ${a.username}, ${a.verified}, ${new Date(now())})
      on conflict (address) do update set
        username = excluded.username, verified = excluded.verified, fetched_at = excluded.fetched_at`
  }

  return {
    async getAccount(raw) {
      const address = raw.toLowerCase()
      const [cached] = await sql<
        { username: string | null; verified: boolean; fetched_at: Date }[]
      >`
        select username, verified, fetched_at from indexer.nft_accounts where address = ${address}`
      if (cached && now() - cached.fetched_at.getTime() < ACCOUNT_REFRESH_MS)
        return { ok: true, value: { username: cached.username, verified: cached.verified } }

      const res = await rest.get(`/accounts/${address}`, 2, parseAccount, OS_REQUEST)
      if (!res.ok) {
        if (res.reason !== "not_found") return res
        const none = { username: null, verified: false }
        await save(address, none)
        return { ok: true, value: none }
      }
      if (!res.value) return { ok: false, reason: "error" }
      await save(address, res.value)
      return { ok: true, value: res.value }
    },
  }
}
