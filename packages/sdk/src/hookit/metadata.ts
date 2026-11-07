import {
  httpsImage,
  ipfsCid,
  type LaunchMetadataFields,
  MAX_DESCRIPTION,
  MAX_LINK,
  object,
  textField,
} from "../metadata"

// shortcut: a fixed bound on the length of an inline URI; Hookit's agent launches use 120 to 300 bytes of JSON, and a larger document would be fetched from IPFS instead.
const MAX_INLINE_URI = 8_192
const INLINE_PREFIX = "data:application/json;base64,"
// Buffer.from(..., "base64") never throws and skips any other character, so the body is checked first.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
// shortcut: recorded documents nest two levels deep; deeper input is refused rather than walked.
const MAX_DEPTH = 8
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HTTPS_PREFIX = /^https:/i

/**
 * The JSON inside a `data:application/json;base64,` URI of at most 8,192 characters. Null for any
 * other URI, a body that is not strict base64, or a body that is not JSON.
 */
export function inlineJson(uri: string): unknown | null {
  if (uri.length > MAX_INLINE_URI) return null
  if (uri.slice(0, INLINE_PREFIX.length).toLowerCase() !== INLINE_PREFIX) return null
  const body = uri.slice(INLINE_PREFIX.length)
  if (body.length % 4 !== 0 || !BASE64.test(body)) return null
  try {
    return JSON.parse(Buffer.from(body, "base64").toString("utf8"))
  } catch {
    return null
  }
}

/** Whether `v` nests objects and arrays deeper than `MAX_DEPTH`, walked without recursion. */
function tooDeep(v: unknown): boolean {
  let level: unknown[] = [v]
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const next: unknown[] = []
    for (const item of level) {
      if (typeof item !== "object" || item === null) continue
      next.push(...Object.values(item))
    }
    if (next.length === 0) return false
    level = next
  }
  return true
}

/** A link as written, unless it carries a scheme other than `https:`: creators type links freely, but `javascript:` must not reach a button. */
const link = (v: unknown): string | null => {
  const s = textField(v, MAX_LINK, false)
  return s === null || (URI_SCHEME.test(s) && !HTTPS_PREFIX.test(s)) ? null : s
}

/**
 * The description, image and links of a Hookit token's metadata JSON, fetched or inline. The image is
 * an `ipfs://` link served through `gateway` or an `https:` URL; anything else is null. Links are the
 * top-level `twitter`, `telegram` and `website`. Null when `json` is not an object or nests too deeply.
 */
export function parseHookitMetadata(json: unknown, gateway: string): LaunchMetadataFields | null {
  const doc = object(json)
  if (doc === null || tooDeep(doc)) return null
  const image = typeof doc.image === "string" ? doc.image : null
  const cid = image === null ? null : ipfsCid(image)
  return {
    description: textField(doc.description, MAX_DESCRIPTION, true),
    imageUrl: cid !== null ? `${gateway}/ipfs/${cid}` : image === null ? null : httpsImage(image),
    links: {
      telegram: link(doc.telegram),
      twitter: link(doc.twitter),
      website: link(doc.website),
    },
  }
}
