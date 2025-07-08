// Logging utility
export function log(message, gameId = null) {
  const timestamp = new Date().toISOString();
  const prefix = gameId ? `[Game ${gameId}]` : `[System]`;
  console.log(`${timestamp} ${prefix} ${message}`);
}

// Helper function to convert BigInt values to numbers for JSON serialization
export function safeJsonConvert(obj) {
  if (typeof obj === "bigint") {
    return Number(obj);
  }
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      return obj.map(safeJsonConvert);
    }
    const converted = {};
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = safeJsonConvert(value);
    }
    return converted;
  }
  return obj;
}

// Helper function to check if a block hash is still available
export async function isBlockHashAvailable(
  gameId,
  globalPublicClient,
  globalContractAddress,
  FULL_CONTRACT_ABI
) {
  try {
    await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitBlockHash",
      args: [BigInt(gameId)],
    });
    return true;
  } catch (error) {
    if (
      error.message.includes("Commit block hash not available") ||
      error.message.includes("too old")
    ) {
      return false;
    }
    return true;
  }
}

// Helper function to check if a game is too old to start
export async function isGameTooOldToStart(
  gameId,
  globalPublicClient,
  globalContractAddress,
  FULL_CONTRACT_ABI
) {
  try {
    const commitState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, commitBlockNumber, , , hasCommitted] = commitState;

    if (!hasCommitted) {
      return false;
    }

    const currentBlockNumber = await globalPublicClient.getBlockNumber();
    const blocksDiff = currentBlockNumber - commitBlockNumber;

    // Ethereum typically keeps 256 blocks of history
    // We'll use 240 as a safety margin
    const MAX_BLOCK_AGE = 240;

    if (blocksDiff > MAX_BLOCK_AGE) {
      log(
        `⚠️ Game is too old to start: committed at block ${commitBlockNumber}, current block ${currentBlockNumber} (${blocksDiff} blocks ago)`,
        gameId
      );
      return true;
    }

    return false;
  } catch (error) {
    log(`❌ Error checking game age: ${error.message}`, gameId);
    return false;
  }
}

// Helper function to mark a game as failed due to being too old
export function markGameAsExpired(gameId, gameStates, GamePhase) {
  const gameState = gameStates.get(gameId);
  if (gameState) {
    gameState.phase = GamePhase.COMPLETE;
    gameState.expired = true;
    gameState.expiredReason = "Block hash too old - game cannot be started";
    gameStates.set(gameId, gameState);

    log(
      `❌ Game marked as EXPIRED: Block hash too old to start game server`,
      gameId
    );
    log(
      `💡 This happens when too much time passes between commit and game closure`,
      gameId
    );
    log(
      `⏰ Games must be closed within ~50 minutes of commit (256 blocks)`,
      gameId
    );
    log(`🔄 Game will be removed from active processing`, gameId);
  }
}

// Logging throttle helper
export function shouldLogWaitingMessage(gameId, lastWaitingLogs) {
  // Handle case where lastWaitingLogs is undefined (from internal calls)
  if (!lastWaitingLogs) {
    return true; // Always log if no throttling map is available
  }

  const now = Date.now();
  const lastLog = lastWaitingLogs.get(gameId) || 0;
  const timeSinceLastLog = now - lastLog;
  const WAITING_LOG_INTERVAL = 30000; // 30 seconds

  if (timeSinceLastLog >= WAITING_LOG_INTERVAL) {
    lastWaitingLogs.set(gameId, now);
    return true;
  }
  return false;
}

// Game state logging helper
export function logGameState(
  gameState,
  gameStates,
  activeGameServer,
  SAVED_DIR,
  verbose = false
) {
  const gameId = gameState.gameId;

  if (verbose) {
    log(`📊 Game State:`, gameId);
    log(`  Phase: ${gameState.phase}`, gameId);
    log(`  Has Opened: ${gameState.hasOpened}`, gameId);
    log(`  Has Closed: ${gameState.hasClosed}`, gameId);
    log(`  Has Committed: ${gameState.hasCommitted}`, gameId);
    log(`  Has Stored Block Hash: ${gameState.hasStoredBlockHash}`, gameId);
    log(`  Has Revealed: ${gameState.hasRevealed}`, gameId);
    log(`  Has Paid Out: ${gameState.hasPaidOut}`, gameId);
    log(`  Player Count: ${gameState.playerCount}`, gameId);
    log(
      `  Active Server: ${activeGameServer === gameId ? "YES" : "NO"}`,
      gameId
    );

    // Check if scores file exists
    try {
      const filePath = `${SAVED_DIR}/scores_${gameId}.txt`;
      const fs = require("fs");
      const scores = fs.readFileSync(filePath, "utf8");
      const scoresData = JSON.parse(scores);
      log(
        `  Scores File: EXISTS (${scoresData.players.length} players)`,
        gameId
      );
    } catch (error) {
      log(`  Scores File: NOT FOUND`, gameId);
    }
  } else {
    log(
      `📊 ${gameState.phase} | Players: ${gameState.playerCount} | Server: ${
        activeGameServer === gameId ? "YES" : "NO"
      }`,
      gameId
    );
  }
}
