import { createClients } from "./clients.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Contract ABI for the payout function
const PAYOUT_ABI = [
  {
    inputs: [{ name: "_winners", type: "address[]" }],
    name: "payout",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// Function to fetch player scores from game server
async function fetchPlayerScores() {
  try {
    const response = await fetch("http://localhost:8000/players");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();

    if (!data.success) {
      throw new Error("Failed to fetch player data from game server");
    }

    return data.players;
  } catch (error) {
    throw new Error(`Failed to fetch player scores: ${error.message}`);
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
  try {
    console.log("\n💰 Game Payout: Paying Winners");
    console.log("==============================");

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

    // Fetch player scores from game server
    console.log("\n📊 Fetching player scores from game server...");
    const players = await fetchPlayerScores();

    if (players.length === 0) {
      console.log("❌ No players found in the game");
      process.exit(1);
    }

    console.log(`✅ Found ${players.length} players`);

    // Display all player scores
    console.log("\n🏆 Player Leaderboard:");
    console.log("========================");
    const sortedPlayers = players.sort((a, b) => b.score - a.score);
    sortedPlayers.forEach((player, index) => {
      const rank = index + 1;
      const medal =
        rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "  ";
      console.log(
        `${medal} ${rank}. ${player.address} - ${player.score} points`
      );
    });

    // Find winners
    const { winners, highestScore } = findWinners(players);

    if (winners.length === 0) {
      console.log("❌ No winners found");
      process.exit(1);
    }

    console.log(`\n🎯 Winners (${highestScore} points):`);
    winners.forEach((winner, index) => {
      console.log(`${index + 1}. ${winner}`);
    });

    if (winners.length > 1) {
      console.log(`🤝 There's a ${winners.length}-way tie for first place!`);
    }

    // Check contract balance before payout
    const contractBalance = await publicClient.getBalance({
      address: contractAddress,
    });

    const contractBalanceEth = Number(contractBalance) / 1e18;
    console.log(`\n💸 Contract Balance: ${contractBalanceEth.toFixed(6)} ETH`);

    if (contractBalance === 0n) {
      console.log("❌ No funds available for payout");
      process.exit(1);
    }

    const amountPerWinner = contractBalance / BigInt(winners.length);
    const amountPerWinnerEth = Number(amountPerWinner) / 1e18;

    console.log(`💰 Payout per winner: ${amountPerWinnerEth.toFixed(6)} ETH`);

    // Call payout function
    console.log(
      `\n🚀 Calling payout function with ${winners.length} winner(s)...`
    );

    const payoutTxHash = await walletClient.writeContract({
      address: contractAddress,
      abi: PAYOUT_ABI,
      functionName: "payout",
      args: [winners],
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
      const newBalance = await publicClient.getBalance({
        address: contractAddress,
      });
      const newBalanceEth = Number(newBalance) / 1e18;
      console.log(`\n💰 New contract balance: ${newBalanceEth.toFixed(6)} ETH`);

      console.log(`\n🎉 Successfully paid out ${winners.length} winner(s)!`);
      console.log(`💸 Total distributed: ${contractBalanceEth.toFixed(6)} ETH`);
      console.log(`🎯 Amount per winner: ${amountPerWinnerEth.toFixed(6)} ETH`);
    } else {
      console.log(`❌ Payout transaction failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);

    if (error.message.includes("Not authorized")) {
      console.log("💡 Make sure you're using the gamemaster private key");
    } else if (error.message.includes("No funds available")) {
      console.log("💡 Contract has no ETH balance to distribute");
    } else if (error.message.includes("fetch")) {
      console.log(
        "💡 Make sure the game server is running on http://localhost:8000"
      );
      console.log("💡 Run 'node game.js' to start the game server");
    }

    process.exit(1);
  }
}

main();
