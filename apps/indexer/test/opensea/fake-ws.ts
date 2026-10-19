import type { WebSocketLike } from "../../src/sources/opensea/stream"

/** A Phoenix v2 frame: `[join_ref, ref, topic, event, payload]`. */
export type Frame = [string | null, string | null, string, string, unknown]

/**
 * A scripted OpenSea Stream server. Each socket it hands out opens on the next microtask, accepts
 * up to `joinCap` collection topics (later joins get an error reply with an empty response, as the
 * real server does past 50) and answers heartbeats. Replies arrive on a later microtask.
 *
 * Test hooks: `refuse` closes that many new sockets with 1006 before they open, `heartbeats = false`
 * stops heartbeat replies, and each socket's `serverClose` and `push` close it or send a frame.
 */
export class FakeStream {
  /** Topics a new socket accepts. */
  joinCap = 50
  /** New sockets still to refuse. */
  refuse = 0
  /** Whether heartbeats get a reply. */
  heartbeats = true
  readonly sockets: FakeSocket[] = []

  /** The socket factory to inject. */
  readonly factory = (url: string): WebSocketLike => {
    const s = new FakeSocket(this, url, this.refuse > 0)
    if (this.refuse > 0) this.refuse--
    this.sockets.push(s)
    return s
  }

  /** The sockets that are open now. */
  openSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.state === "open")
  }
}

export class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null
  onmessage: ((data: string) => void) | null = null
  onclose: ((code: number, reason: string) => void) | null = null
  state: "connecting" | "open" | "closed" = "connecting"
  /** Every frame the client sent, parsed. */
  readonly sent: Frame[] = []
  /** Topics joined and not left. */
  readonly joined = new Set<string>()
  /** Which side closed the socket. */
  closedBy: "client" | "server" | null = null
  /** Frames delivered to the client, and their bytes. */
  received = 0
  receivedBytes = 0
  private readonly cap: number

  constructor(
    private readonly server: FakeStream,
    readonly url: string,
    refused: boolean,
  ) {
    this.cap = server.joinCap
    queueMicrotask(() => {
      if (this.state !== "connecting") return
      if (refused) return this.serverClose(1006)
      this.state = "open"
      this.onopen?.()
    })
  }

  send(data: string): void {
    if (this.state === "connecting") throw new Error("send before open")
    if (this.state === "closed") return
    const f = JSON.parse(data) as Frame
    this.sent.push(f)
    const [joinRef, ref, topic, event] = f
    if (event === "phx_join") {
      const ok = this.joined.size < this.cap
      if (ok) this.joined.add(topic)
      this.reply([joinRef, ref, topic, "phx_reply", { status: ok ? "ok" : "error", response: {} }])
    } else if (event === "phx_leave") {
      this.joined.delete(topic)
      this.reply([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }])
    } else if (event === "heartbeat" && this.server.heartbeats) {
      this.reply([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }])
    }
  }

  close(): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.closedBy = "client"
    queueMicrotask(() => this.onclose?.(1000, ""))
  }

  /** The server closes the connection. */
  serverClose(code: number, reason = ""): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.closedBy = "server"
    this.onclose?.(code, reason)
  }

  /** The server sends a frame. */
  push(frame: Frame | unknown[]): void {
    if (this.state !== "open") return
    const raw = JSON.stringify(frame)
    this.received++
    this.receivedBytes += Buffer.byteLength(raw)
    this.onmessage?.(raw)
  }

  /** Topics the client asked to join, in order. */
  joins(): string[] {
    return this.sent.filter((f) => f[3] === "phx_join").map((f) => f[2])
  }

  /** Topics the client left, in order. */
  leaves(): string[] {
    return this.sent.filter((f) => f[3] === "phx_leave").map((f) => f[2])
  }

  private reply(frame: Frame): void {
    queueMicrotask(() => this.push(frame))
  }
}
