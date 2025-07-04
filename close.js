import { createClients } from "./clients.js";
import dotenv from "dotenv";
import fs from "fs";

// Load environment variables
dotenv.config();

// Contract ABI for the game management functions
const GAME_MANAGEMENT_ABI = [
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "closeGame",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getGameInfo",
    outputs: [
      { name: "gamemaster", type: "address" },
      { name: "stakeAmount", type: "uint256" },
      { name: "open", type: "bool" },
      { name: "playerCount", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getPlayers",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
];

// Note: Score saving is now handled by the game server when it's closed with Ctrl+C

async function main() {
  try {
    console.log("\n🎮 Game Management: CLOSE Game");
    console.log("===============================");

    // Parse command line arguments
    const args = process.argv.slice(2);
    const gameIdArg = args.find((arg) => arg.startsWith("--gameId="));
    const gameId = gameIdArg ? gameIdArg.split("=")[1] : args[0];

    if (!gameId) {
      console.error("❌ Game ID is required");
      console.log("Usage: node close.js <gameId>");
      console.log("   or: node close.js --gameId=<gameId>");
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

    // Check current game state
    console.log("\n📊 Checking current game state...");
    const gameInfo = await publicClient.readContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "getGameInfo",
      args: [BigInt(gameId)],
    });

    const [gamemaster, stakeAmount, isGameOpen, playerCount] = gameInfo;

    console.log(`Game Status: ${isGameOpen ? "OPEN" : "CLOSED"}`);
    console.log(`Gamemaster: ${gamemaster}`);
    console.log(`Stake Amount: ${Number(stakeAmount) / 1e18} ETH`);
    console.log(`Current Players: ${playerCount.toString()}`);

    if (!isGameOpen) {
      console.log("⚠️  Game is already closed!");
      console.log(
        `💡 Run 'node open.js ${gameId}' to open the game for players`
      );
      process.exit(0);
    }

    // Show current players before closing
    if (playerCount > 0) {
      console.log("\n👥 Players who joined the game:");
      const players = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "getPlayers",
        args: [BigInt(gameId)],
      });
      players.forEach((player, index) => {
        console.log(`${index + 1}. ${player}`);
      });
      console.log(
        `\n💰 Total ETH staked: ${(
          (Number(playerCount) * Number(stakeAmount)) /
          1e18
        ).toFixed(6)} ETH`
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
      args: [BigInt(gameId)],
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
      const newGameInfo = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "getGameInfo",
        args: [BigInt(gameId)],
      });

      const [, , newGameState, finalPlayerCount] = newGameInfo;

      console.log(`\n📊 Final game state: ${newGameState ? "OPEN" : "CLOSED"}`);
      console.log(`👥 Final player count: ${finalPlayerCount.toString()}`);
      console.log(
        `💰 Total ETH collected: ${(
          (Number(finalPlayerCount) * Number(stakeAmount)) /
          1e18
        ).toFixed(6)} ETH`
      );

      console.log(`\n🎯 Game ${gameId} is now closed!`);
      console.log(`🚫 No more players can join`);
      console.log(`🎲 You can now proceed with commit-reveal if needed`);
      console.log(`🔄 Run 'node open.js ${gameId}' to reopen this game`);
      console.log(`\n💡 Next steps:`);
      console.log(`1. Run 'node game.js ${gameId}' to start the game server`);
      console.log(`2. Players can now play the game`);
      console.log(
        `3. Press Ctrl+C to stop the game server and save final scores`
      );
      console.log(
        `4. Run 'node payout.js ${gameId}' to distribute prizes to winners`
      );
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
    } else if (error.message.includes("Game does not exist")) {
      console.log("💡 Game does not exist. Make sure the game ID is correct");
    }
    process.exit(1);
  }
}

main();
