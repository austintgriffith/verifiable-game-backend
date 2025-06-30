// Contract addresses on Base (works on both mainnet and localhost fork)
// Base forks maintain all the same contract addresses but use chain ID 31337
export const SUPPORTED_CHAIN_IDS = [8453, 31337]; // Base mainnet, Base fork

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const ETH_USDC_POOL_ADDRESS =
  "0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18"; // Uniswap V3 ETH/USDC pool on Base

// Contract addresses by network - IDENTICAL for both Base mainnet and fork
export const CONTRACT_ADDRESSES = {
  // Base mainnet (8453)
  8453: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH_USDC_POOL: "0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18",
  },
  // Base fork (31337) - SAME addresses as mainnet
  31337: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH_USDC_POOL: "0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18",
  },
};

// Helper function to get contract addresses for current chain
export const getContractAddresses = (chainId = 8453) => {
  if (CONTRACT_ADDRESSES[chainId]) {
    return CONTRACT_ADDRESSES[chainId];
  }
  // Default to Base addresses for unknown chains
  return CONTRACT_ADDRESSES[8453];
};

// DEX configurations - IDENTICAL on both Base mainnet and fork
export const DEXS = {
  AERODROME: {
    name: "Aerodrome Finance",
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    emoji: "🌪️",
    priority: 1,
    type: "aerodrome",
  },
  UNISWAP_V2: {
    name: "Uniswap V2",
    router: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    emoji: "🦄",
    priority: 2,
    type: "uniswap_v2",
  },
  UNISWAP_V3: {
    name: "Uniswap V3",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    emoji: "🚀",
    priority: 3,
    type: "uniswap_v3",
  },
};

// Additional router addresses for account.js compatibility
export const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
export const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
export const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";

// WETH ABI for wrapping, unwrapping and approval
export const WETH_ABI = [
  {
    inputs: [],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// ERC-20 ABI for balanceOf and approval
export const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// Aerodrome Router ABI
export const AERODROME_ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    name: "swapExactTokensForTokens",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
];

// Uniswap V2 Router ABI
export const UNISWAP_V2_ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    name: "swapExactTokensForTokens",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
];

// Uniswap V3 Router ABI
export const UNISWAP_V3_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// Uniswap V3 Pool ABI for slot0 function (to get current price)
export const UNISWAP_V3_POOL_ABI = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
];
