import { loadOpenSeaFixture } from "./fixtures"

export type FakeResponse = { status: number; body?: unknown; headers?: Record<string, string> }
/** What a path answers with: a response, a function of the request, or an error to throw from fetch. */
export type Route = FakeResponse | Error | ((req: FakeRequest) => FakeResponse | Error)
export type FakeRequest = { path: string; url: string; headers: Record<string, string> }
export type FakeFetch = typeof fetch & { calls: FakeRequest[] }

/** The recorded response saved under `name` (for example "collections/ink-hornet"). */
export function recorded(name: string): FakeResponse {
  return loadOpenSeaFixture(name) as FakeResponse
}

const BASE = "https://api.opensea.io/api/v2"

/**
 * A fetch that answers from a table keyed by request path (the part after /api/v2, without the
 * query). A path with no route throws, so a test that asks for the wrong thing fails loudly.
 */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const calls: FakeRequest[] = []
  const fn = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const u = new URL(url)
    const path = u.pathname.replace(/^\/api\/v2/, "")
    const req: FakeRequest = {
      path,
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    }
    calls.push(req)
    if (!url.startsWith(BASE)) throw new Error(`unexpected host: ${u.host}`)
    const route = routes[path]
    if (route === undefined) throw new Error(`no route for ${path}`)
    const out = typeof route === "function" ? route(req) : route
    if (out instanceof Error) throw out
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status,
      headers: { "content-type": "application/json", ...out.headers },
    })
  }
  return Object.assign(fn, { calls }) as FakeFetch
}
