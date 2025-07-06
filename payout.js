import { createClients } from "./clients.js";
import dotenv from "dotenv";
import fs from "fs";

// Load environment variables
dotenv.config();

// File system constants
const SAVED_DIR = "saved";

// Contract ABI for the payout function
const PAYOUT_ABI = [
  {
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "_winners", type: "address[]" },
    ],
    name: "payout",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getGameInfo",
    outputs: [
      { name: "gamemaster", type: "address" },
      { name: "creator", type: "address" },
      { name: "stakeAmount", type: "uint256" },
      { name: "open", type: "bool" },
      { name: "playerCount", type: "uint256" },
      { name: "hasOpened", type: "bool" },
      { name: "hasClosed", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getPayoutInfo",
    outputs: [
      { name: "winners", type: "address[]" },
      { name: "payoutAmount", type: "uint256" },
      { name: "hasPaidOut", type: "bool" },
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
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getPlayerCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// Function to read player scores from saved file
function readPlayerScores(gameId) {
  try {
    const filePath = `${SAVED_DIR}/scores_${gameId}.txt`;
    console.log(`📊 Reading final player scores from ${filePath}...`);
    const scoresData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`✅ Loaded scores (saved at ${scoresData.savedAt})`);
    return scoresData.players;
  } catch (error) {
    throw new Error(
      `Failed to read ${SAVED_DIR}/scores_${gameId}.txt: ${error.message}`
    );
  }
}

// Function to find winners (highest scoring addresses)
function findWinners(players) {
  if (players.length === 0) {
    return [];
  }

  // Find the highest score
  const highestScore = Math.max(...players.map((p) => p.score));

  // Find all players with the highest score
  const winners = players
    .filter((p) => p.score === highestScore)
    .map((p) => p.address);

  return { winners, highestScore };
}

async function main() {
  // Parse command line arguments (moved outside try block for scope)
  const args = process.argv.slice(2);
  const gameIdArg = args.find((arg) => arg.startsWith("--gameId="));
  const gameId = gameIdArg ? gameIdArg.split("=")[1] : args[0];

  if (!gameId) {
    console.error("❌ Game ID is required");
    console.log("Usage: node payout.js <gameId>");
    console.log("   or: node payout.js --gameId=<gameId>");
    process.exit(1);
  }

  try {
    console.log("\n💰 Game Payout: Paying Winners");
    console.log("==============================");
    console.log(`🎮 Game ID: ${gameId}`);

    // Get contract address from environment
    const contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) {
      console.error("❌ CONTRACT_ADDRESS not found in .env file");
      process.exit(1);
    }

    // Create clients and account
    const { account, publicClient, walletClient } = createClients();
    console.log(`Gamemaster Account: ${account.address}`);
    console.log(`Contract: ${contractAddress}`);

    // Get game info to calculate prize pool
    console.log("\n📊 Fetching game information...");

    // Check if already paid out
    const payoutInfo = await publicClient.readContract({
      address: contractAddress,
      abi: PAYOUT_ABI,
      functionName: "getPayoutInfo",
      args: [BigInt(gameId)],
    });

    const [existingWinners, existingPayoutAmount, hasPaidOut] = payoutInfo;
    console.log(`Game Status: ${hasPaidOut ? "ALREADY PAID OUT" : "UNPAID"}`);

    if (hasPaidOut) {
      console.log("❌ Game has already been paid out!");
      console.log(`Previous winners: ${existingWinners.join(", ")}`);
      console.log(
        `Previous payout amount: ${Number(existingPayoutAmount) / 1e18} ETH`
      );
      process.exit(1);
    }

    // Get game info using the corrected ABI
    const gameInfo = await publicClient.readContract({
      address: contractAddress,
      abi: PAYOUT_ABI,
      functionName: "getGameInfo",
      args: [BigInt(gameId)],
    });

    const [
      gamemaster,
      creator,
      stakeAmount,
      open,
      playerCount,
      hasOpened,
      hasClosed,
    ] = gameInfo;
    console.log(`Gamemaster: ${gamemaster}`);
    console.log(`Creator: ${creator}`);
    console.log(`Stake Amount: ${Number(stakeAmount) / 1e18} ETH`);
    console.log(`Game Status: ${open ? "OPEN" : "CLOSED"}`);
    console.log(`Player Count: ${playerCount.toString()}`);
    console.log(`Has Opened: ${hasOpened}`);
    console.log(`Has Closed: ${hasClosed}`);

    // Calculate total prize pool for this game
    const gamePrizePool = BigInt(stakeAmount) * BigInt(playerCount);
    console.log(`🏆 Game Prize Pool: ${Number(gamePrizePool) / 1e18} ETH`);

    // Read final player scores from file
    const playerScores = readPlayerScores(gameId);

    if (playerScores.length === 0) {
      console.log("❌ No players found in the game");
      process.exit(1);
    }

    console.log(`✅ Found ${playerScores.length} players`);

    // Display all player scores
    console.log("\n🏆 Player Leaderboard:");
    console.log("========================");
    const sortedPlayers = playerScores.sort((a, b) => b.score - a.score);
    sortedPlayers.forEach((player, index) => {
      const rank = index + 1;
      const medal =
        rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "  ";
      console.log(
        `${medal} ${rank}. ${player.address} - ${player.score} points`
      );
    });

    // Find winners
    const { winners: foundWinners, highestScore } = findWinners(playerScores);

    if (foundWinners.length === 0) {
      console.log("❌ No winners found");
      process.exit(1);
    }

    console.log(`\n🎯 Winners (${highestScore} points):`);
    foundWinners.forEach((winner, index) => {
      console.log(`${index + 1}. ${winner}`);
    });

    if (foundWinners.length > 1) {
      console.log(
        `🤝 There's a ${foundWinners.length}-way tie for first place!`
      );
    }

    // Check contract balance before payout
    const currentContractBalance = await publicClient.getBalance({
      address: contractAddress,
    });

    const contractBalanceEth = Number(currentContractBalance) / 1e18;
    console.log(`\n💸 Contract Balance: ${contractBalanceEth.toFixed(6)} ETH`);

    if (currentContractBalance < gamePrizePool) {
      console.log(
        "❌ Contract doesn't have enough funds for this game's payout"
      );
      console.log(
        `💡 Required: ${
          Number(gamePrizePool) / 1e18
        } ETH, Available: ${contractBalanceEth} ETH`
      );
      process.exit(1);
    }

    const amountPerWinner = gamePrizePool / BigInt(foundWinners.length);
    const amountPerWinnerEth = Number(amountPerWinner) / 1e18;

    console.log(`💰 Payout per winner: ${amountPerWinnerEth.toFixed(6)} ETH`);

    // Call payout function
    console.log(
      `\n🚀 Calling payout function for game ${gameId} with ${foundWinners.length} winner(s)...`
    );

    const payoutTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: PAYOUT_ABI,
      functionName: "payout",
      args: [BigInt(gameId), foundWinners],
    });

    console.log(`Payout transaction: ${payoutTxHash}`);
    console.log(`🔗 View on explorer: https://basescan.org/tx/${payoutTxHash}`);

    // Wait for confirmation
    console.log("⏳ Waiting for transaction confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: payoutTxHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Payout completed successfully!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Verify new contract balance
      const finalContractBalance = await publicClient.getBalance({
        address: contractAddress,
      });
      const newBalanceEth = Number(finalContractBalance) / 1e18;
      console.log(`\n💰 New contract balance: ${newBalanceEth.toFixed(6)} ETH`);

      console.log(
        `\n🎉 Successfully paid out ${foundWinners.length} winner(s) for game ${gameId}!`
      );
      console.log(`💸 Total distributed: ${Number(gamePrizePool) / 1e18} ETH`);
      console.log(`🎯 Amount per winner: ${amountPerWinnerEth.toFixed(6)} ETH`);
    } else {
      console.log(`❌ Payout transaction failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);

    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("No players in the game")) {
      console.log("💡 No players have joined this game yet");
    } else if (error.message.includes("Failed to read")) {
      console.log(`💡 Could not find ${SAVED_DIR}/scores_${gameId}.txt`);
      console.log(
        `💡 Make sure you ran 'node game.js ${gameId}' and closed it with Ctrl+C after players finished the game`
      );
    } else if (error.message.includes("Game does not exist")) {
      console.log("💡 Game does not exist. Make sure the game ID is correct");
    }

    process.exit(1);
  }
}

main();
