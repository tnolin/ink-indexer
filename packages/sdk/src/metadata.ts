// Helpers shared by the launchpads that read token metadata from IPFS documents.

/** Text and links of a launch, read from the token's metadata JSON. */
export type LaunchMetadataFields = {
  description: string | null
  imageUrl: string | null
  links: { telegram: string | null; twitter: string | null; website: string | null }
}

const IPFS_PREFIX = "ipfs://"
const CID_AND_PATH = /^[A-Za-z0-9]+(\/[A-Za-z0-9._~-]+)*$/

/** The CID and path of an `ipfs://<cid>[/path]` URI. Null for any other scheme or a malformed URI. */
export function ipfsCid(uri: string): string | null {
  if (!uri.startsWith(IPFS_PREFIX)) return null
  const rest = uri.slice(IPFS_PREFIX.length)
  if (!CID_AND_PATH.test(rest)) return null
  return rest.split("/").some((part) => part === "." || part === "..") ? null : rest
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
export const MAX_DESCRIPTION = 4_000
export const MAX_LINK = 2_048

/** Text from a creator or an IPFS document made safe to store: Postgres refuses NUL in text and jsonb, and lone surrogates in jsonb. */
export function cleanText(s: string): string {
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\ufffd")
}

/** A non-empty cleaned string of at most `max` characters; longer text is cut when `cut` is set and dropped otherwise. */
export const textField = (v: unknown, max: number, cut: boolean): string | null => {
  if (typeof v !== "string") return null
  const s = cleanText(v)
  if (s === "") return null
  if (s.length <= max) return s
  return cut ? cleanText(s.slice(0, max)) : null
}

/** An `https:` image URL of at most 2,048 characters without credentials, in its normalized form. */
export function httpsImage(v: string): string | null {
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null
    return u.href.length <= MAX_LINK ? u.href : null
  } catch {
    return null
  }
}

/** An image served by `gateway` for an `ipfs://` URI, or an `https:` image; null for anything else or a URL over 2,048 characters. */
export function launchImage(image: string | null, gateway: string): string | null {
  if (image === null) return null
  const cid = ipfsCid(image)
  if (cid === null) return httpsImage(image)
  const url = `${gateway}/ipfs/${cid}`
  return url.length <= MAX_LINK ? url : null
}

export const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
