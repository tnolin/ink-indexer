import { settleBounded } from "../bounded"
import type { Chain } from "../chain"
import { BlockNotServedError } from "../errors"
import { isTipRefusal } from "../rpc"

/** Block-sender reads a backfill span keeps in flight. Each is one request, retried and moved between endpoints on its own. */
export const BACKFILL_BLOCK_READS = 8

export type BlockSenders = NonNullable<Awaited<ReturnType<Chain["getBlockSenders"]>>>

/**
 * A read at `block` that the endpoint answered with an RPC error, such as "header not found" from a
 * load-balanced node that does not have the block yet, fails the span as not served so the tick
 * retries it. Transport errors pass through unchanged.
 */
export async function servedAt<T>(block: bigint, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (isTipRefusal(err)) throw new BlockNotServedError(block)
    throw err
  }
}

/**
 * The reader a span asks for each block's senders. The live tick reads a block when it is asked,
 * as it always has. A backfill span reads every block up front, `limit` at a time, and answers from
 * those reads in whatever order it is asked; a failed read throws when its own block is asked.
 */
export async function blockSendersFor(
  chain: Pick<Chain, "getBlockSenders">,
  blocks: readonly bigint[],
  opts: { live: boolean; limit?: number },
): Promise<(n: bigint) => Promise<BlockSenders | null>> {
  const read = (n: bigint) => servedAt(n, () => chain.getBlockSenders(n))
  if (opts.live) return read
  const settled = await settleBounded(blocks, opts.limit ?? BACKFILL_BLOCK_READS, read)
  const reads = new Map(blocks.map((n, i) => [n, settled[i]!]))
  return async (n) => {
    const result = reads.get(n)
    if (!result) return read(n)
    if (result.status === "rejected") throw result.reason
    return result.value
  }
}
