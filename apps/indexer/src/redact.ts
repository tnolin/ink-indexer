import { httpUrlFor } from "./rpc"

export const REDACTED = "[redacted]"

/** The strings to hide for one configured endpoint: the URL, its form without a query, its HTTP form, its credentials, path segments and query values. */
export function secretsFor(value: string, withHttpForm: boolean): string[] {
  const out = [value]
  const add = (raw: string) => {
    try {
      const u = new URL(raw)
      out.push(raw, `${u.protocol}//${u.host}${u.pathname}`)
      const parts = [
        u.username,
        u.password,
        ...u.pathname.split("/"),
        ...[...u.searchParams.values()],
      ]
      for (const part of parts) {
        out.push(part)
        try {
          out.push(decodeURIComponent(part))
        } catch {
          // malformed escape: the raw part is already listed
        }
      }
    } catch {
      // not a URL: the raw value above is all there is to hide
    }
  }
  add(value)
  if (withHttpForm) {
    try {
      add(httpUrlFor(value))
    } catch {
      // unsupported scheme: no HTTP form exists
    }
  }
  return out
}
