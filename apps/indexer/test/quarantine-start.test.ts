import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { clearLivePause, replaySources, startPauses } from "../src/quarantine"
import { nftSource } from "../src/sources/nft/index"
import type { BackfillSource, Source, SourceName } from "../src/sources/source"
import { createStore, type Store } from "../src/store"
import { readSources, startSourceServices } from "../src/wiring"
import { FakeChain } from "./fake-chain"
import { createFakeWrites, plainWriter, recordingLogger, writerLog } from "./quarantine-harness"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  await createFakeWrites(sql)
})
afterEach(() => sql.end())

const ADDRESS = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`
const quiet: Logger = () => {}

/** An open live pause for `source`, as the indexer records it. */
const pause = (source: SourceName, fromBlock = S) =>
  store.recordQuarantine({
    source,
    kind: "pause",
    mode: "live",
    fromBlock,
    toBlock: null,
    replaySources: replaySources(source, "pause"),
    sqlstate: "22003",
    message: "refused",
  })

const written = async () =>
  (await sql<{ source: string }[]>`select source from indexer.fake_writes order by source`).map(
    (r) => r.source,
  )

/** A plain writer that keeps the `only` each tick offers it. */
function watching(
  name: SourceName,
  groups: readonly BackfillSource[],
  address: Address,
  seen: (readonly BackfillSource[] | undefined)[],
): Source {
  const source = plainWriter(name, groups, address)
  return {
    ...source,
    filters(only) {
      seen.push(only)
      return source.filters(only)
    },
  }
}

describe("sources with an open live pause at start", () => {
  it("start leaves out a source with an open live pause and logs it once at warn", async () => {
    await pause("inkypump")
    const chain = new FakeChain(S + 9n)
    chain.add(writerLog(ADDRESS(0xa1), S + 2n))
    chain.add(writerLog(ADDRESS(0xa2), S + 3n))
    const logs = recordingLogger()
    const paused = await startPauses(sql, logs.logger)
    const idx = new Indexer({
      chain,
      store,
      logger: logs.logger,
      sources: [
        plainWriter("inkypump", ["inkypump"], ADDRESS(0xa1)),
        plainWriter("tsunami", ["tsunami"], ADDRESS(0xa2)),
      ],
      paused,
    })
    await idx.init()
    await idx.trigger()

    expect(paused).toEqual(["inkypump"])
    expect(logs.at("warn")).toEqual([
      {
        level: "warn",
        msg: "paused sources left out until cleared",
        fields: { sources: ["inkypump"] },
      },
    ])
    expect(await written()).toEqual(["tsunami"])
    expect(idx.paused()).toEqual(["inkypump"])
  })

  it("start logs nothing when no source is paused", async () => {
    const logs = recordingLogger()
    expect(await startPauses(sql, logs.logger)).toEqual([])
    expect(logs.lines).toEqual([])
  })

  it("a paused inkypump keeps v4-swaps for inkfun, tsunami and hookit", async () => {
    await pause("inkypump")
    const chain = new FakeChain(S + 9n)
    const seen: (readonly BackfillSource[] | undefined)[] = []
    const selection = readSources({ INDEXER_SOURCES: "inkypump,inkfun,tsunami,hookit" }, quiet)
    const idx = new Indexer({
      chain,
      store,
      logger: quiet,
      only: selection.groups,
      sources: [
        plainWriter("inkypump", ["inkypump"], ADDRESS(0xa1)),
        watching("inkfun", ["inkfun"], ADDRESS(0xa2), seen),
        watching("tsunami", ["tsunami"], ADDRESS(0xa3), seen),
        watching("hookit", ["hookit"], ADDRESS(0xa4), seen),
        watching("v4", ["v4-swaps"], ADDRESS(0xa5), seen),
      ],
      paused: await startPauses(sql, quiet),
    })
    await idx.init()
    chain.add(writerLog(ADDRESS(0xa1), S + 1n))
    chain.add(writerLog(ADDRESS(0xa5), S + 2n))
    await idx.trigger()

    expect(seen).toHaveLength(4)
    for (const only of seen) expect(only).toEqual(["v4-swaps", "inkfun", "tsunami", "hookit"])
    expect(await written()).toEqual(["v4"])
  })

  it("a cleared pause runs the source again on the next start", async () => {
    await pause("inkypump")
    expect(await startPauses(sql, quiet)).toEqual(["inkypump"])
    expect(await clearLivePause(sql, "inkypump")).not.toBeNull()
    const paused = await startPauses(sql, quiet)
    expect(paused).toEqual([])

    const chain = new FakeChain(S + 9n)
    chain.add(writerLog(ADDRESS(0xa1), S + 2n))
    const idx = new Indexer({
      chain,
      store,
      logger: quiet,
      sources: [plainWriter("inkypump", ["inkypump"], ADDRESS(0xa1))],
      paused,
    })
    await idx.init()
    await idx.trigger()
    expect(await written()).toEqual(["inkypump"])
  })

  it("nft paused with opensea and chimera on: no nft-mints, nft-sales or nft-launches filter is read, and the selection still starts the OpenSea services", async () => {
    await pause("nft")
    const selection = readSources({ INDEXER_SOURCES: "opensea,chimera" }, quiet)
    const chain = new FakeChain(S + 9n)
    const asked: unknown[] = []
    const getLogs = chain.getLogs.bind(chain)
    chain.getLogs = (from, to, filter) => {
      asked.push(filter)
      return getLogs(from, to, filter)
    }
    const idx = new Indexer({
      chain,
      store,
      logger: quiet,
      only: selection.groups,
      sources: [nftSource({ sql, chain, logger: quiet })],
      paused: await startPauses(sql, quiet),
    })
    await idx.init()
    await idx.trigger()
    expect(selection.groups).toEqual(["nft-mints", "nft-sales", "nft-launches"])
    expect(asked).toEqual([])
    expect(await store.getCursor()).toMatchObject({ block: S + 9n })

    const warnings: string[] = []
    const services = await startSourceServices(selection, {
      env: {},
      sql,
      store,
      chain,
      log: (level, msg) => void (level === "warn" && warnings.push(msg)),
      report: () => {},
    })
    services.stop()
    expect(selection.openSea).toBe(true)
    expect(warnings).toEqual([
      "OPENSEA_API_KEY is not set: OpenSea collections, drops, stats and listings are off",
    ])
  })

  it("an unknown source name in the table is logged and ignored", async () => {
    await sql`
      insert into indexer.quarantine (source, kind, mode, from_block, replay_sources, sqlstate, message)
      values ('zorbl', 'pause', 'live', ${S.toString()}, 'zorbl', '22003', 'refused')`
    await pause("tsunami")
    const logs = recordingLogger()
    expect(await startPauses(sql, logs.logger)).toEqual(["tsunami"])
    expect(logs.at("warn")).toEqual([
      {
        level: "warn",
        msg: "paused sources left out until cleared",
        fields: { sources: ["tsunami"], unknown: ["zorbl"] },
      },
    ])
  })
})
