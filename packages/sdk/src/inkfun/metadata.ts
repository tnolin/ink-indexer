import {
  cleanText,
  ipfsCid,
  type LaunchMetadataFields,
  MAX_DESCRIPTION,
  MAX_LINK,
  textField,
} from "../metadata"

export { cleanText, ipfsCid, type LaunchMetadataFields }

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
    description: textField(doc.description, MAX_DESCRIPTION, true),
    imageUrl: image === null ? null : `${gateway}/ipfs/${image}`,
    links: {
      telegram: textField(ext.telegram, MAX_LINK, false),
      twitter: textField(ext.twitter, MAX_LINK, false),
      website: textField(ext.website, MAX_LINK, false),
    },
  }
}
