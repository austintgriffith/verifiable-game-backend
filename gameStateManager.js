import fs from "fs";
import { FULL_CONTRACT_ABI, GamePhase, SAVED_DIR } from "./constants.js";
import {
  log,
  shouldLogWaitingMessage,
  logGameState,
  isGameTooOldToStart,
  markGameAsExpired,
  isBlockHashAvailable,
} from "./utils.js";
import {
  commitHashForGame,
  storeCommitBlockHashForGame,
  payoutGame,
  revealGame,
} from "./contractService.js";
import { loadGameScores } from "./fileService.js";
import {
  getCurrentPlayerData,
  forceFinishGameOnTimer,
  getTimeRemaining,
} from "./gameServer.js";

// Game state management functions

export async function updateGameState(
  gameId,
  globalPublicClient,
  globalContractAddress,
  gameStates,
  activeGameServer
) {
  try {
    const gameInfo = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
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

    const commitState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, , , , hasCommitted, hasRevealed, hasStoredBlockHash, mapSize] =
      commitState;

    const payoutInfo = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPayoutInfo",
      args: [BigInt(gameId)],
    });

    const [, , hasPaidOut] = payoutInfo;

    let phase = GamePhase.CREATED;
    if (hasRevealed) {
      phase = GamePhase.COMPLETE;
    } else if (hasPaidOut) {
      phase = GamePhase.PAYOUT_COMPLETE;
    } else if (hasClosed && hasCommitted && hasStoredBlockHash) {
      try {
        const playerScores = loadGameScores(gameId);
        const allPlayersFinished = playerScores.every((p) => {
          return (
            p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0)
          );
        });
        if (allPlayersFinished) {
          phase = GamePhase.GAME_FINISHED;
        } else if (activeGameServer === gameId) {
          phase = GamePhase.GAME_RUNNING;
        } else {
          phase = GamePhase.CLOSED;
        }
      } catch (error) {
        if (activeGameServer === gameId) {
          phase = GamePhase.GAME_RUNNING;
        } else {
          phase = GamePhase.CLOSED;
        }
      }
    } else if (hasCommitted) {
      phase = GamePhase.COMMITTED;
    }

    const currentState = gameStates.get(gameId) || {};

    if (currentState.payoutSkipped && phase === GamePhase.GAME_FINISHED) {
      phase = GamePhase.PAYOUT_COMPLETE;
    }
    if (currentState.revealSkipped && phase === GamePhase.PAYOUT_COMPLETE) {
      phase = GamePhase.COMPLETE;
    }

    gameStates.set(gameId, {
      ...currentState,
      gameId,
      gamemaster,
      creator,
      stakeAmount,
      open,
      playerCount,
      hasOpened,
      hasClosed,
      hasCommitted,
      hasRevealed,
      hasStoredBlockHash,
      hasPaidOut,
      mapSize: Number(mapSize) || 0,
      phase,
      lastUpdated: Date.now(),
    });

    return gameStates.get(gameId);
  } catch (error) {
    log(`Error updating game state: ${error.message}`, gameId);
    return null;
  }
}

export async function processGamePhase(
  gameId,
  gameStates,
  activeGameServer,
  globalPublicClient,
  globalWalletClient,
  globalContractAddress,
  lastWaitingLogs,
  payoutRetryCount,
  payoutLastRetryTime,
  revealRetryCount,
  revealLastRetryTime,
  completedGamesCount,
  startGameServerFn,
  monitorGameProgressFn
) {
  const gameState = await updateGameState(
    gameId,
    globalPublicClient,
    globalContractAddress,
    gameStates,
    activeGameServer
  );
  if (!gameState) {
    log(`❌ Could not update game state`, gameId);
    return;
  }

  const lastState = gameStates.get(gameId);
  const phaseChanged = !lastState || lastState.phase !== gameState.phase;

  const immediateActionPhases = [
    GamePhase.CREATED,
    GamePhase.CLOSED,
    GamePhase.GAME_FINISHED,
    GamePhase.PAYOUT_COMPLETE,
  ];

  const needsImmediateAction = immediateActionPhases.includes(gameState.phase);

  const needsBlockHashStorage =
    gameState.phase === GamePhase.COMMITTED &&
    gameState.hasCommitted &&
    !gameState.hasStoredBlockHash;

  const shouldLogThisCycle =
    phaseChanged ||
    needsImmediateAction ||
    shouldLogWaitingMessage(gameId, lastWaitingLogs);

  let inBackoff = false;
  const now = Date.now();

  if (
    gameState.phase === GamePhase.GAME_FINISHED &&
    payoutRetryCount.has(gameId)
  ) {
    const retryCount = payoutRetryCount.get(gameId);
    const lastRetryTime = payoutLastRetryTime.get(gameId) || 0;
    const BACKOFF_MS = Math.min(5000 * Math.pow(2, retryCount - 1), 300000);
    const timeUntilRetry = Math.max(0, BACKOFF_MS - (now - lastRetryTime));
    inBackoff = timeUntilRetry > 0;
  }

  if (
    gameState.phase === GamePhase.PAYOUT_COMPLETE &&
    revealRetryCount.has(gameId)
  ) {
    const retryCount = revealRetryCount.get(gameId);
    const lastRetryTime = revealLastRetryTime.get(gameId) || 0;
    const BACKOFF_MS = 10000;
    const timeUntilRetry = Math.max(0, BACKOFF_MS - (now - lastRetryTime));
    inBackoff = timeUntilRetry > 0;
  }

  if (shouldLogThisCycle) {
    if (phaseChanged || needsImmediateAction) {
      logGameState(gameState, gameStates, activeGameServer, SAVED_DIR, true);
    } else if (!inBackoff) {
      logGameState(gameState, gameStates, activeGameServer, SAVED_DIR, false);
    }
  }

  switch (gameState.phase) {
    case GamePhase.CREATED:
      log(`🎯 Action needed: Commit hash and store block hash`, gameId);
      const commitSuccess = await commitHashForGame(
        gameId,
        globalPublicClient,
        globalWalletClient,
        globalContractAddress
      );
      if (commitSuccess) {
        log(`✅ Commit phase completed`, gameId);
      } else {
        log(`❌ Commit phase failed`, gameId);
      }
      break;

    case GamePhase.COMMITTED:
      if (needsBlockHashStorage) {
        const blockHashActionKey = `block_hash_action_${gameId}`;
        if (shouldLogWaitingMessage(blockHashActionKey, lastWaitingLogs)) {
          log(`🎯 Action needed: Store commit block hash`, gameId);
        }

        const storeSuccess = await storeCommitBlockHashForGame(
          gameId,
          globalPublicClient,
          globalWalletClient,
          globalContractAddress,
          lastWaitingLogs
        );
        if (storeSuccess) {
          log(`✅ Block hash storage completed`, gameId);
        } else {
          if (shouldLogWaitingMessage(blockHashActionKey, lastWaitingLogs)) {
            log(`❌ Block hash storage failed (will retry)`, gameId);
          }
        }
      } else {
        if (shouldLogThisCycle && !needsImmediateAction) {
          log(
            `⏳ Game is open for players to join. Waiting for game to be closed by creator...`,
            gameId
          );
        }
      }
      break;

    case GamePhase.CLOSED:
      if (activeGameServer === gameId) {
        log(`✅ Game server already running for this game`, gameId);
      } else if (activeGameServer !== null) {
        if (shouldLogThisCycle) {
          log(
            `⏳ Waiting for server slot (Game ${activeGameServer} currently active)`,
            gameId
          );
        }
      } else {
        log(`🎯 Action needed: Start game server`, gameId);
        const serverStarted = await startGameServerFn(gameId);
        if (!serverStarted) {
          const updatedGameState = gameStates.get(gameId);
          if (updatedGameState) {
            updatedGameState.phase = GamePhase.GAME_FINISHED;
            gameStates.set(gameId, updatedGameState);
            log(
              `📊 Game phase updated to GAME_FINISHED (already completed)`,
              gameId
            );
          }
        }
      }
      break;

    case GamePhase.GAME_RUNNING:
      await monitorGameProgressFn(gameId);
      break;

    case GamePhase.GAME_FINISHED:
      const retryCount = payoutRetryCount.get(gameId) || 0;
      const lastRetryTime = payoutLastRetryTime.get(gameId) || 0;
      const now = Date.now();

      if (retryCount > 0) {
        const RETRY_BACKOFF_MS = Math.min(
          5000 * Math.pow(2, retryCount - 1),
          300000
        );
        const timeUntilRetry = Math.max(
          0,
          RETRY_BACKOFF_MS - (now - lastRetryTime)
        );

        if (timeUntilRetry > 0) {
          const retryLogKey = `payout_retry_${gameId}`;
          if (shouldLogWaitingMessage(retryLogKey, lastWaitingLogs)) {
            log(
              `⏳ Payout retry ${retryCount}/10 in ${Math.round(
                timeUntilRetry / 1000
              )}s (insufficient funds)`,
              gameId
            );
          }
          break;
        }
      }

      log(
        `🎯 Action needed: Execute payout${
          retryCount > 0 ? ` (retry ${retryCount + 1}/10)` : ""
        }`,
        gameId
      );
      const payoutSuccess = await payoutGame(
        gameId,
        globalPublicClient,
        globalWalletClient,
        globalContractAddress,
        payoutRetryCount,
        payoutLastRetryTime,
        gameStates
      );
      if (payoutSuccess) {
        log(`✅ Payout phase completed`, gameId);
      } else {
        const newRetryCount = payoutRetryCount.get(gameId) || 0;
        if (newRetryCount < 10) {
          log(`❌ Payout phase failed (will retry)`, gameId);
        }
      }
      break;

    case GamePhase.PAYOUT_COMPLETE:
      const currentGameState = gameStates.get(gameId);
      if (currentGameState && currentGameState.payoutSkipped) {
        log(`⚠️ Note: Payout was skipped due to insufficient funds`, gameId);
        log(`💡 Winners were not paid out on-chain`, gameId);
      }

      const currentRevealRetryCount = revealRetryCount.get(gameId) || 0;
      const currentRevealLastRetryTime = revealLastRetryTime.get(gameId) || 0;
      const currentTime = Date.now();

      if (currentRevealRetryCount > 0) {
        const RETRY_BACKOFF_MS = 10000;
        const timeUntilRetry = Math.max(
          0,
          RETRY_BACKOFF_MS - (currentTime - currentRevealLastRetryTime)
        );

        if (timeUntilRetry > 0) {
          const retryLogKey = `reveal_retry_${gameId}`;
          if (shouldLogWaitingMessage(retryLogKey, lastWaitingLogs)) {
            log(
              `⏳ Final reveal attempt in ${Math.round(
                timeUntilRetry / 1000
              )}s (blockhash too old - will give up after this)`,
              gameId
            );
          }
          break;
        }
      }

      log(
        `🎯 Action needed: Reveal hash${
          currentRevealRetryCount > 0
            ? ` (final attempt - will give up if this fails)`
            : ""
        }`,
        gameId
      );
      const revealSuccess = await revealGame(
        gameId,
        globalPublicClient,
        globalWalletClient,
        globalContractAddress,
        revealRetryCount,
        revealLastRetryTime,
        gameStates
      );
      if (revealSuccess) {
        const finalGameState = gameStates.get(gameId);
        if (finalGameState && finalGameState.revealSkipped) {
          log(
            `⚠️ Note: Reveal was skipped due to blockhash being too old`,
            gameId
          );
          log(
            `💡 Game is complete but random hash was not revealed on-chain`,
            gameId
          );
        }
        log(`✅ Reveal phase completed`, gameId);

        log(`⏲️ Scheduling game server shutdown in 15 seconds...`, gameId);
        setTimeout(() => {
          if (activeGameServer === gameId) {
            log(
              `🛑 Delayed shutdown: Stopping game server for completed game ${gameId}`,
              gameId
            );
            // This would need to be called from the main module
          } else {
            log(
              `⏭️ Skipping delayed shutdown - different game server now active`,
              gameId
            );
          }
        }, 15000);
      } else {
        const newRetryCount = revealRetryCount.get(gameId) || 0;
        if (newRetryCount < 1) {
          log(`❌ Reveal phase failed (will retry)`, gameId);
        }
      }
      break;

    case GamePhase.COMPLETE:
      log(`🎉 Game fully completed!`, gameId);
      completedGamesCount++;
      log(
        `🗑️ Removing game ${gameId} from active processing (${completedGamesCount} total completed)`,
        gameId
      );
      gameStates.delete(gameId);
      lastWaitingLogs.delete(gameId);
      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);
      revealRetryCount.delete(gameId);
      revealLastRetryTime.delete(gameId);

      const keysToDelete = [];
      for (const [key, value] of lastWaitingLogs.entries()) {
        if (
          key.startsWith("timer_warning_") ||
          key.startsWith("payout_retry_") ||
          key.startsWith("reveal_retry_") ||
          key.startsWith("block_hash_waiting_") ||
          key.startsWith("block_hash_action_") ||
          key.startsWith("block_hash_start_")
        ) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => lastWaitingLogs.delete(key));
      break;

    default:
      log(`❓ Unknown game phase: ${gameState.phase}`, gameId);
      break;
  }
}

export async function monitorGameProgress(
  gameId,
  activeGameServer,
  gameStates,
  lastWaitingLogs
) {
  try {
    if (activeGameServer !== gameId) {
      log(`⚠️ Cannot monitor - server not running for this game`, gameId);
      return;
    }

    const timeRemaining = getTimeRemaining();
    if (timeRemaining <= 0 && getTimeRemaining !== null) {
      log(`⏰ Timer expired! Force finishing game...`, gameId);
      forceFinishGameOnTimer(gameId);
    } else if (getTimeRemaining !== null) {
      const warningTimes = [60, 30, 10, 5];
      const currentTime = Math.floor(timeRemaining);

      if (warningTimes.includes(currentTime)) {
        const warningKey = `timer_warning_${currentTime}`;
        if (!lastWaitingLogs.has(warningKey)) {
          log(`⏰ Timer warning: ${currentTime} seconds remaining!`, gameId);
          lastWaitingLogs.set(warningKey, Date.now());
        }
      }
    }

    const playerData = getCurrentPlayerData(gameId);

    if (playerData.length === 0) {
      log(`⚠️ No player data available yet`, gameId);
      return;
    }

    const allPlayersFinished = playerData.every((p) => {
      return p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0);
    });

    if (allPlayersFinished) {
      log(`🏁 All players finished! Saving final scores...`, gameId);

      log(`📊 Final Results:`, gameId);
      playerData.forEach((player, index) => {
        log(`  Player ${index + 1}: ${player.address}`, gameId);
        log(
          `    Score: ${player.score}, Moves: ${player.movesRemaining}, Mines: ${player.minesRemaining}, Current tile: ${player.tile}`,
          gameId
        );
      });

      // This would need to be called from the main module
      // saveGameScores(gameId, playerData);

      log(`🌐 Keeping game server running for payout/reveal phase...`, gameId);

      const currentMonitoringGameState = gameStates.get(gameId);
      if (currentMonitoringGameState) {
        currentMonitoringGameState.phase = GamePhase.GAME_FINISHED;
        gameStates.set(gameId, currentMonitoringGameState);
        log(`📊 Game phase updated to GAME_FINISHED`, gameId);
      }

      log(`✅ Game completed, ready for payout`, gameId);
    }
  } catch (error) {
    log(`❌ Error monitoring game progress: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);
  }
}
