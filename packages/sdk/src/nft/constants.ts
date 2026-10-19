import type { Address, Hex } from "viem"

/** SeaDrop v1, the drop contract behind most Ink mints. */
export const SEADROP_V1: Address = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
export const SEAPORT_1_6: Address = "0x0000000000000068f116a894984e2db1123eb395"
export const SEAPORT_1_5: Address = "0x00000000000000adc04c56bf30ac9d3c0aaf14dc"
export const WETH_INK: Address = "0x4200000000000000000000000000000000000006"

/** Chimera factory proxy, and the block it was deployed at. */
export const CHIMERA_FACTORY: Address = "0xa66c05f14e79f40952531c20de0b60282e3800be"
export const CHIMERA_FACTORY_START_BLOCK = 57_096_880n
export const CHIMERA_HOOK: Address = "0x2eebd90bf253a27961624762f73eee1409c52dcc"
export const CHIMERA_ROUTER: Address = "0x16bb706af367386f2cdf92a4bb673dcdb5fe1886"

export const NFT_TOPICS = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  transferSingle: "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
  transferBatch: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
  seadropMint: "0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6",
  publicDropUpdated: "0x3e30d8e1f739ea4795c481b21c23f905e938b80339305f3508e43c558e5dead3",
  orderFulfilled: "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
  campaignCreated: "0x001b4892649817454e3dcb90d0d534ad709c098776f4f6de335baf16506299b3",
} as const satisfies Record<string, Hex>

/** The zero address as a 32-byte topic. */
export const ZERO_TOPIC: Hex = `0x${"0".repeat(64)}`

/** Four-byte selectors of the collection reads used for supply. */
export const NFT_SELECTORS = {
  getMintStats: "0x840e15d4",
  maxSupply: "0xd5abeb01",
  MAX_SUPPLY: "0x32cb6b0c",
  totalSupply: "0x18160ddd",
  // Chimera collections: the supply of permanent (non-burnable) tokens and its cap.
  permanentSupply: "0x16a5b1bb",
  maxPermanent: "0xd156a766",
} as const satisfies Record<string, Hex>
