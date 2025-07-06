import { createClients } from "./clients.js";
import { keccak256, toBytes, toHex } from "viem";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// File system constants
const SAVED_DIR = "saved";

// Ensure saved directory exists
function ensureSavedDirectory() {
  if (!existsSync(SAVED_DIR)) {
    mkdirSync(SAVED_DIR, { recursive: true });
    console.log(`📁 Created saved directory: ${SAVED_DIR}`);
  }
}

// Contract ABI for the commit-reveal functions
const COMMIT_REVEAL_ABI = [
  {
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "_hash", type: "bytes32" },
    ],
    name: "commitHash",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getCommitRevealState",
    outputs: [
      { name: "_committedHash", type: "bytes32" },
      { name: "_commitBlockNumber", type: "uint256" },
      { name: "_revealValue", type: "bytes32" },
      { name: "_randomHash", type: "bytes32" },
      { name: "_hasCommitted", type: "bool" },
      { name: "_hasRevealed", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "resetGame",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// Generate random bytes32 value
function generateRandomReveal() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return toHex(randomBytes);
}

async function main() {
  try {
    console.log("\n🎲 Commit-Reveal System: COMMIT Phase");
    console.log("======================================");

    // Parse command line arguments
    const args = process.argv.slice(2);
    const gameIdArg = args.find((arg) => arg.startsWith("--gameId="));
    const gameId = gameIdArg ? gameIdArg.split("=")[1] : args[0];

    if (!gameId) {
      console.error("❌ Game ID is required");
      console.log("Usage: node commit.js <gameId> [--reset]");
      console.log("   or: node commit.js --gameId=<gameId> [--reset]");
      process.exit(1);
    }

    console.log(`🎮 Game ID: ${gameId}`);

    // Get contract address from environment
    const contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) {
      console.error("❌ CONTRACT_ADDRESS not found in .env file");
      process.exit(1);
    }

    // Create clients and account
    const { account, publicClient, walletClient } = createClients();
    console.log(`Account: ${account.address}`);
    console.log(`Contract: ${contractAddress}`);

    // Check current state
    console.log("\n📊 Checking current commit-reveal state...");
    const currentState = await publicClient.readContract({
      address: contractAddress,
      abi: COMMIT_REVEAL_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [
      committedHash,
      commitBlockNumber,
      revealValue,
      randomHash,
      hasCommitted,
      hasRevealed,
    ] = currentState;

    console.log(`Has Committed: ${hasCommitted}`);
    console.log(`Has Revealed: ${hasRevealed}`);

    if (hasCommitted && !hasRevealed) {
      console.log(
        "⚠️  There's already a pending commit that hasn't been revealed yet!"
      );
      console.log(`Committed Hash: ${committedHash}`);
      console.log(`Commit Block Number: ${commitBlockNumber}`);
      console.log("\n🔄 You can either:");
      console.log(
        "1. Run 'node reveal.js <gameId>' to reveal the existing commit"
      );
      console.log("2. Add --reset flag to reset and make a new commit");

      if (!args.includes("--reset")) {
        process.exit(1);
      }

      console.log("\n🔄 Resetting game...");
      const resetHash = await walletClient.writeContract({
        address: contractAddress,
        abi: COMMIT_REVEAL_ABI,
        functionName: "resetGame",
        args: [BigInt(gameId)],
      });

      console.log(`Reset transaction: ${resetHash}`);
      await publicClient.waitForTransactionReceipt({ hash: resetHash });
      console.log("✅ Game reset successfully");
    }

    // Generate random reveal value
    console.log("\n🎲 Generating random reveal value...");
    const revealBytes32 = generateRandomReveal();
    console.log(`Reveal value: ${revealBytes32}`);

    // Hash the reveal value to create the commit hash
    const commitHash = keccak256(toBytes(revealBytes32));
    console.log(`Commit hash: ${commitHash}`);

    // Save reveal value to file for later use
    ensureSavedDirectory();
    const revealFilePath = `${SAVED_DIR}/reveal_${gameId}.txt`;
    console.log(`\n💾 Saving reveal value to ${revealFilePath}...`);
    writeFileSync(revealFilePath, revealBytes32);
    console.log("✅ Reveal value saved successfully");

    // Commit the hash to the contract
    console.log("\n🚀 Committing hash to contract...");
    const commitTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: COMMIT_REVEAL_ABI,
      functionName: "commitHash",
      args: [BigInt(gameId), commitHash],
    });

    console.log(`Commit transaction: ${commitTxHash}`);
    console.log(`🔗 View on explorer: https://basescan.org/tx/${commitTxHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: commitTxHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Commit successful!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Check the new state
      const newState = await publicClient.readContract({
        address: contractAddress,
        abi: COMMIT_REVEAL_ABI,
        functionName: "getCommitRevealState",
        args: [BigInt(gameId)],
      });

      const [newCommittedHash, newCommitBlockNumber] = newState;
      console.log(`\n📊 New commit state:`);
      console.log(`Committed Hash: ${newCommittedHash}`);
      console.log(`Commit Block Number: ${newCommitBlockNumber}`);

      console.log(`\n🎯 Next steps:`);
      console.log(
        `1. Wait for at least block ${newCommitBlockNumber} (current: ${await publicClient.getBlockNumber()})`
      );
      console.log(
        `2. Run 'node reveal.js ${gameId}' to reveal and generate randomness`
      );
      console.log(
        `3. The reveal value is saved in ${SAVED_DIR}/reveal_${gameId}.txt`
      );
    } else {
      console.log(`❌ Commit failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("Previous commit must be revealed")) {
      console.log(
        "💡 Use --reset flag to reset the system, or run reveal.js first"
      );
    }
    process.exit(1);
  }
}

main();
