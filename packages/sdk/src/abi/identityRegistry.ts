/**
 * ERC-8004 Identity Registry, minimal surface (ERC-721 agent ids with a URI). Taken from the ERC-8004 draft
 * reference interface (`register(string agentURI)` returns the new agentId and emits `Registered`). Checked
 * 2026-10-28 against erc-8004/erc-8004-contracts b9e466c IdentityRegistryUpgradeable.sol (getVersion 2.0.0): the
 * proxies on Robinhood Chain mainnet (0x8004A169…a432) and testnet (0x8004A818…BD9e) both point at implementation
 * 0x7274…9c02, and register / tokenURI / ownerOf / Registered round-tripped on an anvil fork of 46630.
 */
export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;
