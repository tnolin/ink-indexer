import type { Address } from "viem"

export const NFTX_API_BASE = "https://api.nftx.io/v1/ink"

/** The longest response body read; a collection record is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5_000
/** A slug as it appears in an NFTX URL: lowercase letters, digits and hyphens. */
const SLUG = /^[a-z0-9-]{1,100}$/

/**
 * The name NFTX's web pages use for a collection, from its API. Null for anything but a 200
 * response with a well-formed slug: an unknown collection, a failure, a timeout, an oversized body
 * or a slug outside `[a-z0-9-]`. The slug ends up in a URL path, so nothing else is accepted.
 */
export async function fetchNftxSlug(
  collection: Address,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const doFetch = opts.fetch ?? fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await doFetch(`${NFTX_API_BASE}/collections/${collection}`, {
      signal,
      redirect: "error",
      headers: { accept: "application/json" },
    })
    if (res.status !== 200 || !res.body) return null
    const text = await readCapped(res.body, MAX_BODY_BYTES)
    if (text === null) return null
    const slug = (JSON.parse(text) as { slug?: unknown } | null)?.slug
    return typeof slug === "string" && SLUG.test(slug) ? slug : null
  } catch {
    return null
  }
}

/** The body as text, or null when it is longer than `max` bytes (the rest is not read). */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
