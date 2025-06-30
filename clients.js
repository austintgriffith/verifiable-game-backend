import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import { getChainConfig, SUPPORTED_CHAIN_IDS } from "./chains.js";

// Load environment variables
dotenv.config();

// Network configuration guide:
//
// For Base Mainnet:
// CHAIN_ID=8453
// ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/your-api-key
//
// For Base Fork (localhost):
// CHAIN_ID=31337  (localhost fork uses 31337)
// ALCHEMY_API_KEY=http://localhost:8545
//
// Contract addresses are identical on both networks since 31337 is a Base fork

// Create account from private key
export const createAccountFromEnv = () => {
  const privateKey = process.env.PRIVKEY;
  if (!privateKey) {
    throw new Error("❌ PRIVKEY not found in .env file");
  }

  return privateKeyToAccount(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
  );
};

// Create public client
export const createPublicClientForChain = () => {
  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 8453;

  // Validate supported chain
  if (!SUPPORTED_CHAIN_IDS.includes(chainId)) {
    console.warn(
      `⚠️  Chain ID ${chainId} not explicitly supported. Supported: ${SUPPORTED_CHAIN_IDS.join(
        ", "
      )}`
    );
  }

  // Determine RPC URL based on configuration
  let rpcUrl = process.env.ALCHEMY_API_KEY;

  if (!rpcUrl) {
    if (chainId === 8453) {
      rpcUrl = "https://mainnet.base.org"; // Default Base RPC
    } else if (chainId === 31337) {
      rpcUrl = "http://localhost:8545"; // Default localhost fork
    } else {
      rpcUrl = "http://localhost:8545"; // Default localhost
    }
  }

  const isLocalhost =
    rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1");
  const networkType = isLocalhost ? "Fork/Localhost" : "Mainnet";

  console.log(
    `🔗 Connecting to Base ${networkType} (Chain ID: ${chainId}) via ${rpcUrl}`
  );

  return createPublicClient({
    chain: getChainConfig(),
    transport: http(rpcUrl),
  });
};

// Create wallet client
export const createWalletClientForChain = (account) => {
  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 8453;

  let rpcUrl = process.env.ALCHEMY_API_KEY;

  if (!rpcUrl) {
    if (chainId === 8453) {
      rpcUrl = "https://mainnet.base.org";
    } else if (chainId === 31337) {
      rpcUrl = "http://localhost:8545";
    } else {
      rpcUrl = "http://localhost:8545";
    }
  }

  return createWalletClient({
    account,
    chain: getChainConfig(),
    transport: http(rpcUrl),
  });
};

// Create both clients at once (common pattern)
export const createClients = () => {
  const account = createAccountFromEnv();
  const publicClient = createPublicClientForChain();
  const walletClient = createWalletClientForChain(account);

  return { account, publicClient, walletClient };
};
