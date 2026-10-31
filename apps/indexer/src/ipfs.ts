import { ipfsCid } from "@ink-indexer/sdk"
import type { Address } from "viem"
import type { Logger } from "./log"

/** The IPFS gateway ink.fun's site uses for token metadata and images. */
export const DEFAULT_IPFS_GATEWAY = "https://cracker.mypinata.cloud"

const MAX_BODY_BYTES = 64 * 1024
const RETRY_DELAY_MS = 500

export type IpfsDeps = {
  /** HTTPS origin without a trailing slash. */
  gateway: string
  fetch?: typeof fetch
  /** Per attempt, covering the headers and the body (default 3,000). */
  timeoutMs?: number
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  log?: Logger
  /** Named in the warning when every attempt fails. */
  token?: Address
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The response body as text, or null once it passes `MAX_BODY_BYTES`. */
async function readBounded(res: Response): Promise<string | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * The JSON behind an `ipfs://` URI, fetched through the gateway. Other schemes are never fetched.
 * Makes up to `attempts` (3) tries, each bounded by `timeoutMs`; a non-200 answer, a timeout or a
 * body over 64 KB is retried, and a body that is not JSON ends the attempts. Null after the last
 * failure, with one warning that names the token and never the gateway URL.
 */
export async function fetchIpfsJson(uri: string, deps: IpfsDeps): Promise<unknown | null> {
  const cid = ipfsCid(uri)
  if (cid === null) return null
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? wait
  const attempts = deps.attempts ?? 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await doFetch(`${deps.gateway}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(deps.timeoutMs ?? 3_000),
      })
      if (res.status === 200) {
        const body = await readBounded(res)
        if (body !== null) {
          try {
            return JSON.parse(body)
          } catch {
            break
          }
        }
      } else {
        await res.body?.cancel()
      }
    } catch {
      // timeout or network error: try again
    }
    if (attempt < attempts) await sleep(RETRY_DELAY_MS)
  }
  deps.log?.("warn", "ink.fun metadata not fetched", { token: deps.token })
  return null
}
