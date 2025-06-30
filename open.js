import { createClients } from "./clients.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Contract ABI for the game management functions
const GAME_MANAGEMENT_ABI = [
  {
    inputs: [],
    name: "openGame",
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
    console.log("\n🎮 Game Management: OPEN Game");
    console.log("==============================");

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

    if (isGameOpen) {
      console.log("⚠️  Game is already open!");
      console.log("💡 Players can join by calling joinGame() with 0.001 ETH");
      console.log("💡 Run 'node close.js' to close the game");

      if (playerCount > 0) {
        const players = await publicClient.readContract({
          address: contractAddress,
          abi: GAME_MANAGEMENT_ABI,
          functionName: "getPlayers",
        });
        console.log("\n👥 Current players:");
        players.forEach((player, index) => {
          console.log(`${index + 1}. ${player}`);
        });
      }

      process.exit(0);
    }

    // Open the game
    console.log("\n🚀 Opening game for players to join...");
    const openTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "openGame",
    });

    console.log(`Open game transaction: ${openTxHash}`);
    console.log(`🔗 View on explorer: https://basescan.org/tx/${openTxHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: openTxHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Game opened successfully!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Verify the new state
      const newGameState = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "open",
      });

      console.log(`\n📊 New game state: ${newGameState ? "OPEN" : "CLOSED"}`);
      console.log(`\n🎯 Game is now open for players to join!`);
      console.log(`💰 Players must stake exactly 0.001 ETH to join`);
      console.log(`🎮 Players can call joinGame() to participate`);
      console.log(`🔒 Run 'node close.js' when ready to close the game`);
    } else {
      console.log(`❌ Opening game failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("Game is already open")) {
      console.log("💡 Game is already open for players to join");
    }
    process.exit(1);
  }
}

main();
