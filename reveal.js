import { createClients } from "./clients.js";
import { readFileSync } from "fs";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Contract ABI for the commit-reveal functions
const COMMIT_REVEAL_ABI = [
  {
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "_reveal", type: "bytes32" },
    ],
    name: "revealHash",
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
];

// Read reveal value from file
function readRevealValue(gameId) {
  try {
    const revealValue = readFileSync(`reveal_${gameId}.txt`, "utf8").trim();
    if (!revealValue) {
      throw new Error("Reveal file is empty");
    }
    return revealValue;
  } catch (error) {
    throw new Error(`Failed to read reveal_${gameId}.txt: ${error.message}`);
  }
}

async function main() {
  try {
    console.log("\n🔮 Commit-Reveal System: REVEAL Phase");
    console.log("======================================");

    // Parse command line arguments
    const args = process.argv.slice(2);
    const gameIdArg = args.find((arg) => arg.startsWith("--gameId="));
    const gameId = gameIdArg ? gameIdArg.split("=")[1] : args[0];

    if (!gameId) {
      console.error("❌ Game ID is required");
      console.log("Usage: node reveal.js <gameId>");
      console.log("   or: node reveal.js --gameId=<gameId>");
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
    console.log(`Commit Block Number: ${commitBlockNumber}`);

    if (!hasCommitted) {
      console.log("❌ No hash has been committed yet!");
      console.log(`💡 Run 'node commit.js ${gameId}' first to commit a hash`);
      process.exit(1);
    }

    if (hasRevealed) {
      console.log("⚠️  Hash has already been revealed!");
      console.log(`Previous Reveal Value: ${revealValue}`);
      console.log(`Generated Random Hash: ${randomHash}`);
      console.log(
        `💡 Run 'node commit.js ${gameId} --reset' to start a new commit-reveal cycle`
      );
      process.exit(1);
    }

    // Check if we can reveal (block number requirement)
    const currentBlockNumber = await publicClient.getBlockNumber();
    console.log(`Current Block Number: ${currentBlockNumber}`);

    if (currentBlockNumber < commitBlockNumber) {
      console.log(
        `❌ Cannot reveal yet! Must wait until block ${commitBlockNumber}`
      );
      console.log(
        `💡 Wait for ${commitBlockNumber - currentBlockNumber} more blocks`
      );
      process.exit(1);
    }

    // Read reveal value from file
    console.log(`\n📖 Reading reveal value from reveal_${gameId}.txt...`);
    const storedRevealValue = readRevealValue(gameId);
    console.log(`Reveal value: ${storedRevealValue}`);

    // Reveal the hash
    console.log("\n🚀 Revealing hash to contract...");
    const revealTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: COMMIT_REVEAL_ABI,
      functionName: "revealHash",
      args: [BigInt(gameId), storedRevealValue],
    });

    console.log(`Reveal transaction: ${revealTxHash}`);
    console.log(`🔗 View on explorer: https://basescan.org/tx/${revealTxHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: revealTxHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Reveal successful!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Check the final state and show the generated randomness
      const finalState = await publicClient.readContract({
        address: contractAddress,
        abi: COMMIT_REVEAL_ABI,
        functionName: "getCommitRevealState",
        args: [BigInt(gameId)],
      });

      const [, , finalRevealValue, finalRandomHash] = finalState;
      console.log(`\n🎉 Random hash generated successfully!`);
      console.log(`📊 Final state for game ${gameId}:`);
      console.log(`Reveal Value: ${finalRevealValue}`);
      console.log(`🎲 Generated Random Hash: ${finalRandomHash}`);

      console.log(`\n🎯 Commit-reveal cycle complete for game ${gameId}!`);
      console.log(`💡 You can now use the random hash: ${finalRandomHash}`);
      console.log(`🔄 Run 'node commit.js ${gameId}' to start a new cycle`);
    } else {
      console.log(`❌ Reveal failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("No hash has been committed")) {
      console.log("💡 Run 'node commit.js <gameId>' first to commit a hash");
    } else if (error.message.includes("Hash has already been revealed")) {
      console.log(
        "💡 Run 'node commit.js <gameId> --reset' to start a new cycle"
      );
    } else if (error.message.includes("Cannot reveal before")) {
      console.log("💡 Wait for the required block number before revealing");
    } else if (error.message.includes("Reveal does not match")) {
      console.log("💡 The reveal value doesn't match the committed hash");
    } else if (error.message.includes("Blockhash not available")) {
      console.log("💡 The blockhash is too old (more than 256 blocks)");
    } else if (error.message.includes("Failed to read reveal_")) {
      console.log(
        "💡 Make sure reveal_<gameId>.txt exists (run commit.js first)"
      );
    } else if (error.message.includes("Game does not exist")) {
      console.log("💡 Game does not exist. Make sure the game ID is correct");
    }
    process.exit(1);
  }
}

main();
