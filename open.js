import { createClients } from "./clients.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Contract ABI for the game management functions
const GAME_MANAGEMENT_ABI = [
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "openGame",
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

async function main() {
  try {
    console.log("\n🎮 Game Management: OPEN Game");
    console.log("==============================");

    // Parse command line arguments
    const args = process.argv.slice(2);
    const gameIdArg = args.find((arg) => arg.startsWith("--gameId="));
    const gameId = gameIdArg ? gameIdArg.split("=")[1] : args[0];

    if (!gameId) {
      console.error("❌ Game ID is required");
      console.log("Usage: node open.js <gameId>");
      console.log("   or: node open.js --gameId=<gameId>");
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

    if (isGameOpen) {
      console.log("⚠️  Game is already open!");
      console.log(
        `💡 Players can join by calling joinGame(${gameId}) with ${
          Number(stakeAmount) / 1e18
        } ETH`
      );
      console.log(`💡 Run 'node close.js ${gameId}' to close the game`);

      if (playerCount > 0) {
        const players = await publicClient.readContract({
          address: contractAddress,
          abi: GAME_MANAGEMENT_ABI,
          functionName: "getPlayers",
          args: [BigInt(gameId)],
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
      args: [BigInt(gameId)],
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
      const newGameInfo = await publicClient.readContract({
        address: contractAddress,
        abi: GAME_MANAGEMENT_ABI,
        functionName: "getGameInfo",
        args: [BigInt(gameId)],
      });

      const [, , newGameState] = newGameInfo;
      console.log(`\n📊 New game state: ${newGameState ? "OPEN" : "CLOSED"}`);
      console.log(`\n🎯 Game ${gameId} is now open for players to join!`);
      console.log(
        `💰 Players must stake exactly ${
          Number(stakeAmount) / 1e18
        } ETH to join`
      );
      console.log(`🎮 Players can call joinGame(${gameId}) to participate`);
      console.log(
        `🔒 Run 'node close.js ${gameId}' when ready to close the game`
      );
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
    } else if (error.message.includes("Game does not exist")) {
      console.log("💡 Game does not exist. Make sure the game ID is correct");
    }
    process.exit(1);
  }
}

main();
