/**
 * A block the chain endpoint did not return. A lagging node answers null for a block the rest of the
 * network already has, so null means "not known yet", never "does not exist" or "hash differs".
 * The tick catches this, keeps its cursor and tries again on the next head.
 */
export class BlockNotServedError extends Error {
  constructor(readonly block: bigint) {
    super(`block ${block} not served by the endpoint`)
    this.name = "BlockNotServedError"
  }
}

/**
 * A write without the chain cursor (a backfill) would put a confirmed event above one it cannot
 * confirm yet. The transaction rolls back; the caller reads a newer head and writes again.
 */
export class UnconfirmedAboveHeadError extends Error {
  constructor(readonly head: bigint) {
    super(`unconfirmed events remain below this write at head ${head}`)
    this.name = "UnconfirmedAboveHeadError"
  }
}
