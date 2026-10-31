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
const MAX_DESCRIPTION = 4_000
const MAX_LINK = 2_048

/** Text from a creator or an IPFS document made safe to store: Postgres refuses NUL in text and jsonb, and lone surrogates in jsonb. */
export function cleanText(s: string): string {
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\ufffd")
}

/** A non-empty cleaned string of at most `max` characters; longer text is cut when `cut` is set and dropped otherwise. */
const text = (v: unknown, max: number, cut: boolean): string | null => {
  if (typeof v !== "string") return null
  const s = cleanText(v)
  if (s === "") return null
  if (s.length <= max) return s
  return cut ? cleanText(s.slice(0, max)) : null
}

/**
 * The description, image and links of a token's metadata JSON. The image is served through
 * `gateway`; only an `ipfs://` image is kept. Link values are returned as written, since creators
 * type them freely. Null when `json` is not an object.
 */
export function parseInkfunMetadata(json: unknown, gateway: string): LaunchMetadataFields | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null
  const doc = json as Record<string, unknown>
  const ext =
    typeof doc.extensions === "object" && doc.extensions !== null
      ? (doc.extensions as Record<string, unknown>)
      : {}
  const image = typeof doc.image === "string" ? ipfsCid(doc.image) : null
  return {
    description: text(doc.description, MAX_DESCRIPTION, true),
    imageUrl: image === null ? null : `${gateway}/ipfs/${image}`,
    links: {
      telegram: text(ext.telegram, MAX_LINK, false),
      twitter: text(ext.twitter, MAX_LINK, false),
      website: text(ext.website, MAX_LINK, false),
    },
  }
}
