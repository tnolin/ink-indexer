import {
  httpsImage,
  ipfsCid,
  type LaunchMetadataFields,
  MAX_DESCRIPTION,
  MAX_LINK,
  object,
  textField,
} from "../metadata"

const GATEWAY_URI = /^https:\/\/[^/?#@\s]+\/ipfs\/([^?#]*)/

/**
 * The CID and path of a metadata URI that points at an IPFS gateway, `https://<host>/ipfs/<cid>[/path]`,
 * checked like an `ipfs://` URI. The host is discarded: the document is always fetched from the
 * gateway the indexer is configured with, never from a host a creator named. Null for any other URI.
 */
export function gatewayCid(uri: string): string | null {
  const m = GATEWAY_URI.exec(uri)
  return m?.[1] === undefined ? null : ipfsCid(`ipfs://${m[1]}`)
}

/**
 * The description, image and links of a Tsunami token's metadata JSON. The image is kept when it is
 * an `https:` URL, or an `ipfs://` link served through `gateway`; anything else is null. Links are
 * returned as written, since creators type them freely. Null when `json` is not an object.
 */
export function parseTsunamiMetadata(json: unknown, gateway: string): LaunchMetadataFields | null {
  const doc = object(json)
  if (doc === null) return null
  const socials = object(doc.socials) ?? {}
  const image = typeof doc.image === "string" ? doc.image : null
  const cid = image === null ? null : ipfsCid(image)
  return {
    description: textField(doc.description, MAX_DESCRIPTION, true),
    imageUrl: cid !== null ? `${gateway}/ipfs/${cid}` : image === null ? null : httpsImage(image),
    links: {
      telegram: textField(socials.telegram, MAX_LINK, false),
      twitter: textField(socials.x, MAX_LINK, false),
      website: textField(socials.website, MAX_LINK, false),
    },
  }
}
