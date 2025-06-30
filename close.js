import { createClients } from "./clients.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Contract ABI for the game management functions
const GAME_MANAGEMENT_ABI = [
  {
    inputs: [],
    name: "closeGame",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "open",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPlayerCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPlayers",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
];

async function main() {
  try {
    console.log("\n🎮 Game Management: CLOSE Game");
    console.log("===============================");

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

    // Check current game state
    console.log("\n📊 Checking current game state...");
    const isGameOpen = await publicClient.readContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "open",
    });

    const playerCount = await publicClient.readContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "getPlayerCount",
    });

    console.log(`Game Status: ${isGameOpen ? "OPEN" : "CLOSED"}`);
    console.log(`Current Players: ${playerCount.toString()}`);

    if (!isGameOpen) {
      console.log("⚠️  Game is already closed!");
      console.log("💡 Run 'node open.js' to open the game for players");
      process.exit(0);
    }

    // Show current players before closing
    if (playerCount > 0) {
      console.log("\n👥 Players who joined the game:");
      const players = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "getPlayers",
      });
      players.forEach((player, index) => {
        console.log(`${index + 1}. ${player}`);
      });
      console.log(
        `\n💰 Total ETH staked: ${(Number(playerCount) * 0.001).toFixed(3)} ETH`
      );
    } else {
      console.log("\n👥 No players have joined yet");
    }

    // Close the game
    console.log("\n🔒 Closing game (no more players can join)...");
    const closeTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "closeGame",
    });

    console.log(`Close game transaction: ${closeTxHash}`);
    console.log(`🔗 View on explorer: https://basescan.org/tx/${closeTxHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: closeTxHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Game closed successfully!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Verify the new state
      const newGameState = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "open",
      });

      const finalPlayerCount = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "getPlayerCount",
      });

      console.log(`\n📊 Final game state: ${newGameState ? "OPEN" : "CLOSED"}`);
      console.log(`👥 Final player count: ${finalPlayerCount.toString()}`);
      console.log(
        `💰 Total ETH collected: ${(Number(finalPlayerCount) * 0.001).toFixed(
          3
        )} ETH`
      );

      console.log(`\n🎯 Game is now closed!`);
      console.log(`🚫 No more players can join`);
      console.log(`🎲 You can now proceed with commit-reveal if needed`);
      console.log(`🔄 Run 'node open.js' to start a new game`);
    } else {
      console.log(`❌ Closing game failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("Game is already closed")) {
      console.log("💡 Game is already closed");
    }
    process.exit(1);
  }
}

main();
