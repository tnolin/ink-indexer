/** Calls `read` on each item with at most `limit` calls in flight, and settles each result in input order. */
export async function settleBounded<I, T>(
  items: readonly I[],
  limit: number,
  read: (item: I) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const out = new Array<PromiseSettledResult<T>>(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        out[i] = { status: "fulfilled", value: await read(items[i]!) }
      } catch (reason) {
        out[i] = { status: "rejected", reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
