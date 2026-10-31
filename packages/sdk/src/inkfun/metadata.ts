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

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

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
    description: text(doc.description),
    imageUrl: image === null ? null : `${gateway}/ipfs/${image}`,
    links: { telegram: text(ext.telegram), twitter: text(ext.twitter), website: text(ext.website) },
  }
}
