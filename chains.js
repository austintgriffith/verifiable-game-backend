import { base } from "viem/chains";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Supported chain IDs
export const SUPPORTED_CHAIN_IDS = [8453, 31337]; // Base mainnet, Base fork

// Create custom chain configuration
export const getChainConfig = () => {
  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 8453;
  const rpcUrl = process.env.ALCHEMY_API_KEY || "http://localhost:8545";

  if (chainId === 8453) {
    // Base mainnet
    return {
      ...base,
      rpcUrls: {
        default: {
          http: [rpcUrl],
        },
        public: {
          http: [rpcUrl],
        },
      },
    };
  } else if (chainId === 31337) {
    // Base fork - simple config to avoid hardfork issues
    return {
      id: 31337,
      name: "Base Fork",
      network: "base-fork",
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: "ETH",
      },
      rpcUrls: {
        default: {
          http: ["http://localhost:8545"],
        },
        public: {
          http: ["http://localhost:8545"],
        },
      },
      blockExplorers: {
        default: { name: "Local", url: "http://localhost:8545" },
      },
      testnet: true,
    };
  } else {
    // Create custom chain config for other networks
    return {
      id: chainId,
      name: `Custom Network (${chainId})`,
      network: `custom-${chainId}`,
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: "ETH",
      },
      rpcUrls: {
        default: {
          http: [rpcUrl],
        },
        public: {
          http: [rpcUrl],
        },
      },
      blockExplorers: {
        default: { name: "Custom", url: rpcUrl },
      },
      testnet: true,
    };
  }
};
