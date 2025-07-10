import { keccak256, toBytes } from "viem";
import { FULL_CONTRACT_ABI, GamePhase } from "./constants.js";
import { log, shouldLogWaitingMessage } from "./utils.js";
import {
  generateRandomReveal,
  saveRevealValue,
  loadRevealValue,
  loadGameScores,
} from "./fileService.js";

// Contract interaction functions

export async function commitHashForGame(
  gameId,
  globalPublicClient,
  globalWalletClient,
  globalContractAddress
) {
  try {
    log(`Starting commit phase...`, gameId);

    const currentState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, , , , hasCommitted, , hasStoredBlockHash] = currentState;
    if (hasCommitted && hasStoredBlockHash) {
      log(
        `Hash already committed and block hash stored for game ${gameId}`,
        gameId
      );
      return true;
    }

    if (hasCommitted && !hasStoredBlockHash) {
      log(`Hash already committed, attempting to store block hash...`, gameId);
      return await storeCommitBlockHashForGame(
        gameId,
        globalPublicClient,
        globalWalletClient,
        globalContractAddress
      );
    }

    const revealBytes32 = generateRandomReveal();
    log(`Generated reveal value: ${revealBytes32}`, gameId);

    const commitHash = keccak256(toBytes(revealBytes32));
    log(`Generated commit hash: ${commitHash}`, gameId);

    saveRevealValue(gameId, revealBytes32);

    log(`Committing hash to contract...`, gameId);
    const commitTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "commitHash",
      args: [BigInt(gameId), commitHash],
    });

    log(`Commit transaction: ${commitTxHash}`, gameId);

    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: commitTxHash,
    });

    if (receipt.status === "success") {
      log(`Commit successful! Gas used: ${receipt.gasUsed.toString()}`, gameId);
      log(`Game is now open for players to join`, gameId);

      log(`Scheduling block hash storage in 15 seconds...`, gameId);
      setTimeout(async () => {
        await storeCommitBlockHashForGame(
          gameId,
          globalPublicClient,
          globalWalletClient,
          globalContractAddress
        );
      }, 15000);

      return true;
    } else {
      log(`Commit failed!`, gameId);
      return false;
    }
  } catch (error) {
    if (
      error.message.includes("Sender doesn't have enough funds") ||
      error.message.includes("insufficient funds")
    ) {
      log(`💰 Insufficient funds for commit transaction`, gameId);
      log(`💡 Gamemaster account needs ETH for gas fees`, gameId);

      const errorMsg = error.message;
      const balanceMatch = errorMsg.match(/sender's balance is: (\d+)/);
      const costMatch = errorMsg.match(/max upfront cost is: (\d+)/);

      if (balanceMatch && costMatch) {
        const balance = parseInt(balanceMatch[1]);
        const cost = parseInt(costMatch[1]);
        log(`💰 Current balance: ${(balance / 1e18).toFixed(6)} ETH`, gameId);
        log(`💰 Required for tx: ${(cost / 1e18).toFixed(6)} ETH`, gameId);
        log(
          `💰 Need additional: ${((cost - balance) / 1e18).toFixed(6)} ETH`,
          gameId
        );
      }
    } else {
      log(`Error in commit phase: ${error.message}`, gameId);
    }
    return false;
  }
}

export async function storeCommitBlockHashForGame(
  gameId,
  globalPublicClient,
  globalWalletClient,
  globalContractAddress,
  lastWaitingLogs = null
) {
  try {
    const blockHashStartKey = `block_hash_start_${gameId}`;
    if (shouldLogWaitingMessage(blockHashStartKey, lastWaitingLogs)) {
      log(`Starting block hash storage...`, gameId);
    }

    const currentState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, commitBlockNumber, , , hasCommitted, , hasStoredBlockHash] =
      currentState;
    if (!hasCommitted) {
      log(`No hash committed yet for game ${gameId}`, gameId);
      return false;
    }

    if (hasStoredBlockHash) {
      log(`Block hash already stored for game ${gameId}`, gameId);
      return true;
    }

    const currentBlockNumber = await globalPublicClient.getBlockNumber();
    const blockHashLogKey = `block_hash_waiting_${gameId}`;

    if (currentBlockNumber < commitBlockNumber) {
      if (shouldLogWaitingMessage(blockHashLogKey, lastWaitingLogs)) {
        log(`🔍 Block timing debug:`, gameId);
        log(`  - Commit block number: ${commitBlockNumber}`, gameId);
        log(`  - Current block number: ${currentBlockNumber}`, gameId);
        log(
          `  - Blocks passed: ${currentBlockNumber - commitBlockNumber}`,
          gameId
        );
        log(`  - Ready: NO`, gameId);
        log(
          `⏰ Still waiting for commit block ${commitBlockNumber} (currently at ${currentBlockNumber})`,
          gameId
        );
      }
      return false;
    }

    // Generate the game server URL
    const port = 8000 + parseInt(gameId);
    const baseUrl = process.env.GAME_API_BASE || "http://localhost";
    const gameServerUrl = `${baseUrl}:${port}`;

    log(`Storing commit block hash with URL: ${gameServerUrl}`, gameId);
    const storeTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "storeCommitBlockHash",
      args: [BigInt(gameId), gameServerUrl],
    });

    log(`Store block hash transaction: ${storeTxHash}`, gameId);

    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: storeTxHash,
    });

    if (receipt.status === "success") {
      log(
        `Block hash stored successfully! Gas used: ${receipt.gasUsed.toString()}`,
        gameId
      );
      log(`Game server URL stored in contract: ${gameServerUrl}`, gameId);
      log(`Commit phase fully completed - game ready for closure`, gameId);
      return true;
    } else {
      log(`Block hash storage failed!`, gameId);
      return false;
    }
  } catch (error) {
    if (
      error.message.includes("Commit block hash not available") ||
      error.message.includes("too old") ||
      error.message.includes("Must wait for the commit block")
    ) {
      const blockHashLogKey = `block_hash_waiting_${gameId}`;
      if (shouldLogWaitingMessage(blockHashLogKey, lastWaitingLogs)) {
        log(`❌ Block hash storage error details:`, gameId);
        log(`  - Error message: ${error.message}`, gameId);
        log(`  - Error type: ${error.name || "Unknown"}`, gameId);
        log(`⏳ Block not ready yet for hash storage, will retry...`, gameId);
      }
      return false;
    } else if (
      error.message.includes("Sender doesn't have enough funds") ||
      error.message.includes("insufficient funds")
    ) {
      log(`💰 Insufficient funds for block hash storage`, gameId);
      log(`💡 Gamemaster account needs more ETH for gas fees`, gameId);
      return false;
    } else {
      log(`❌ Unexpected error storing block hash: ${error.message}`, gameId);
      if (error.stack) {
        log(`📍 Error stack: ${error.stack}`, gameId);
      }
      return false;
    }
  }
}

export async function payoutGame(
  gameId,
  globalPublicClient,
  globalWalletClient,
  globalContractAddress,
  payoutRetryCount,
  payoutLastRetryTime,
  gameStates
) {
  try {
    log(`Starting payout phase...`, gameId);

    const payoutInfo = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPayoutInfo",
      args: [BigInt(gameId)],
    });

    const [, , hasPaidOut] = payoutInfo;
    if (hasPaidOut) {
      log(`Game already paid out`, gameId);
      return true;
    }

    const retryCount = payoutRetryCount.get(gameId) || 0;
    const lastRetryTime = payoutLastRetryTime.get(gameId) || 0;
    const now = Date.now();
    const MAX_RETRIES = 10;
    const RETRY_BACKOFF_MS = Math.min(
      5000 * Math.pow(2, retryCount - 1),
      300000
    );

    if (retryCount >= MAX_RETRIES) {
      log(`❌ Payout failed after ${MAX_RETRIES} retries - giving up`, gameId);
      log(
        `💡 Please manually fund the gamemaster account and restart the service`,
        gameId
      );

      log(
        `⚠️ Skipping to reveal phase due to persistent payout failures`,
        gameId
      );

      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);

      const gameState = gameStates.get(gameId);
      if (gameState) {
        gameState.payoutSkipped = true;
        gameState.phase = GamePhase.PAYOUT_COMPLETE;
        gameStates.set(gameId, gameState);
      }

      return true;
    }

    if (retryCount > 0 && now - lastRetryTime < RETRY_BACKOFF_MS) {
      return false;
    }

    const playerScores = loadGameScores(gameId);
    if (playerScores.length === 0) {
      log(`No players found for payout`, gameId);
      return false;
    }

    const highestScore = Math.max(...playerScores.map((p) => p.score));
    const winners = playerScores
      .filter((p) => p.score === highestScore)
      .map((p) => p.address);

    log(`Found ${winners.length} winner(s) with score ${highestScore}`, gameId);
    winners.forEach((winner, index) => {
      log(`Winner ${index + 1}: ${winner}`, gameId);
    });

    log(`Executing payout...`, gameId);
    const payoutTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "payout",
      args: [BigInt(gameId), winners],
    });

    log(`Payout transaction: ${payoutTxHash}`, gameId);

    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: payoutTxHash,
    });

    if (receipt.status === "success") {
      log(
        `✅ Payout successful! Gas used: ${receipt.gasUsed.toString()}`,
        gameId
      );

      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);

      return true;
    } else {
      log(
        `❌ Payout transaction failed with status: ${receipt.status}`,
        gameId
      );

      payoutRetryCount.set(gameId, retryCount + 1);
      payoutLastRetryTime.set(gameId, now);

      return false;
    }
  } catch (error) {
    const retryCount = payoutRetryCount.get(gameId) || 0;
    const now = Date.now();

    if (
      error.message.includes("Sender doesn't have enough funds") ||
      error.message.includes("insufficient funds")
    ) {
      log(
        `💰 Insufficient funds for payout (attempt ${retryCount + 1}/${10})`,
        gameId
      );
      log(`💡 Gamemaster account needs more ETH for gas fees`, gameId);

      const errorMsg = error.message;
      const balanceMatch = errorMsg.match(/sender's balance is: (\d+)/);
      const costMatch = errorMsg.match(/max upfront cost is: (\d+)/);

      if (balanceMatch && costMatch) {
        const balance = parseInt(balanceMatch[1]);
        const cost = parseInt(costMatch[1]);
        log(`💰 Current balance: ${(balance / 1e18).toFixed(6)} ETH`, gameId);
        log(`💰 Required for tx: ${(cost / 1e18).toFixed(6)} ETH`, gameId);
        log(
          `💰 Need additional: ${((cost - balance) / 1e18).toFixed(6)} ETH`,
          gameId
        );
      }

      const BACKOFF_MS = Math.min(10000 * Math.pow(2, retryCount), 600000);
      log(
        `⏳ Will retry in ${Math.round(BACKOFF_MS / 1000)} seconds...`,
        gameId
      );
    } else {
      log(`❌ Error in payout phase: ${error.message}`, gameId);
    }

    payoutRetryCount.set(gameId, retryCount + 1);
    payoutLastRetryTime.set(gameId, now);

    return false;
  }
}

export async function revealGame(
  gameId,
  globalPublicClient,
  globalWalletClient,
  globalContractAddress,
  revealRetryCount,
  revealLastRetryTime,
  gameStates
) {
  try {
    log(`Starting reveal phase...`, gameId);

    const currentState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, , , , hasCommitted, hasRevealed] = currentState;
    if (!hasCommitted) {
      log(`No hash committed yet`, gameId);
      return false;
    }
    if (hasRevealed) {
      log(`Hash already revealed`, gameId);
      return true;
    }

    const retryCount = revealRetryCount.get(gameId) || 0;
    const lastRetryTime = revealLastRetryTime.get(gameId) || 0;
    const now = Date.now();
    const MAX_RETRIES = 1;
    const RETRY_BACKOFF_MS = 10000;

    if (retryCount >= MAX_RETRIES) {
      log(`❌ Reveal failed after ${MAX_RETRIES} retries - giving up`, gameId);
      log(`💡 Blockhash likely too old, skipping reveal for this game`, gameId);

      log(`⚠️ Marking game as complete despite reveal failure`, gameId);

      revealRetryCount.delete(gameId);
      revealLastRetryTime.delete(gameId);

      const gameState = gameStates.get(gameId);
      if (gameState) {
        gameState.revealSkipped = true;
        gameState.phase = GamePhase.COMPLETE;
        gameStates.set(gameId, gameState);
      }

      return true;
    }

    if (retryCount > 0 && now - lastRetryTime < RETRY_BACKOFF_MS) {
      return false;
    }

    const revealValue = loadRevealValue(gameId);

    log(`Revealing hash...`, gameId);
    const revealTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "revealHash",
      args: [BigInt(gameId), revealValue],
    });

    log(`Reveal transaction: ${revealTxHash}`, gameId);

    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: revealTxHash,
    });

    if (receipt.status === "success") {
      log(`Reveal successful! Gas used: ${receipt.gasUsed.toString()}`, gameId);

      revealRetryCount.delete(gameId);
      revealLastRetryTime.delete(gameId);

      const finalState = await globalPublicClient.readContract({
        address: globalContractAddress,
        abi: FULL_CONTRACT_ABI,
        functionName: "getCommitRevealState",
        args: [BigInt(gameId)],
      });

      const [, , , randomHash] = finalState;
      log(`Generated random hash: ${randomHash}`, gameId);

      return true;
    } else {
      log(
        `❌ Reveal transaction failed with status: ${receipt.status}`,
        gameId
      );

      revealRetryCount.set(gameId, retryCount + 1);
      revealLastRetryTime.set(gameId, now);

      return false;
    }
  } catch (error) {
    const retryCount = revealRetryCount.get(gameId) || 0;
    const now = Date.now();

    if (error.message.includes("Blockhash not available")) {
      log(
        `📅 Blockhash too old for reveal (attempt ${
          retryCount + 1
        }/1 - will give up)`,
        gameId
      );
      log(
        `💡 This happens when too much time passes between commit and reveal`,
        gameId
      );

      const BACKOFF_MS = 10000;
      log(
        `⏳ Will retry in ${Math.round(BACKOFF_MS / 1000)} seconds...`,
        gameId
      );
    } else {
      log(`❌ Error in reveal phase: ${error.message}`, gameId);
    }

    revealRetryCount.set(gameId, retryCount + 1);
    revealLastRetryTime.set(gameId, now);

    return false;
  }
}
