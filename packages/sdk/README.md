# @ink-indexer/sdk

Decoders, curve math and event builders for InkyPump V2 on Ink. Works with any viem client and your own RPC. MIT licensed.

```ts
import { decodeLog, LOG_TOPICS, curveValue, progressBps } from "@ink-indexer/sdk"

const d = decodeLog(log) // { kind: "trade", side: "buy", sold, price, ... } or null
```

- `decodeLog(log)`: decodes `LaunchCreated`, `LaunchMetadata`, `Trade` and `LaunchFinalized` from any InkyPump V2 hook, plus the xStocks factory's hook-created event.
- `NATIVE_HOOKS`, `XSTOCKS_FACTORIES`, `LOG_TOPICS`, `INKYPUMP_START_BLOCK`: where and what to listen to.
- `curveValue`, `curvePrice`, `progressBps`, `marketCap`: curve math. See `docs/adr/0011-progress-from-curve.md`.
- `readLaunchStates`, `readTotalSupplies`, `readErc20Meta`: multicall readers.
- `launchEvent`, `tradeEvent`, `bondEvent`: build `@ink-indexer/events` payloads.

See [`examples/decode-launches.ts`](../../examples/decode-launches.ts) for a runnable script.
