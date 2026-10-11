import type { Address, Hash, Hex } from "viem"

/** A mined log with lowercase address and hashes. */
export type ChainLog = {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  blockHash: Hash
  transactionHash: Hash
  logIndex: number
}
