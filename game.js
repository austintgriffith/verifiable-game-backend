import dotenv from "dotenv";
import fs from "fs";
import { createClients } from "./clients.js";
import { DeterministicDice, GameLandGenerator } from "deterministic-map";
import { GamePhase, SAVED_DIR, FULL_CONTRACT_ABI } from "./constants.js";
import {
  log,
  safeJsonConvert,
  isGameTooOldToStart,
  markGameAsExpired,
  isBlockHashAvailable,
} from "./utils.js";
import {
  ensureSavedDirectory,
  saveGameMap,
  saveGameScores,
  calculateRandomHash,
  loadRevealValue,
} from "./fileService.js";
import {
  initializeGameServer,
  cleanupGameServer,
  getCurrentPlayerData,
  getActiveGameServers,
  getGameServerInfo,
  generateGameServerUrl,
} from "./gameServer.js";
import { processGamePhase, monitorGameProgress } from "./gameStateManager.js";
import { scanForExistingGames, setupEventListeners } from "./eventListener.js";

dotenv.config();

// ===============================
// AUTOMATED GAME MANAGER SYSTEM
// ===============================

// Global state
let gameStates = new Map();
let activeGameServers = new Map(); // gameId -> { server, isHTTPS, port }
let lastWaitingLogs = new Map();
let payoutRetryCount = new Map();
let payoutLastRetryTime = new Map();
let revealRetryCount = new Map();
let revealLastRetryTime = new Map();
let globalAccount = null;
let globalPublicClient = null;
let globalWalletClient = null;
let globalContractAddress = null;
let completedGamesCount = 0;

// Initialize global blockchain clients
async function initializeGlobalClients() {
  try {
    globalContractAddress = process.env.CONTRACT_ADDRESS;
    if (!globalContractAddress) {
      throw new Error("CONTRACT_ADDRESS not found in .env file");
    }

    const { account, publicClient, walletClient } = createClients();
    globalAccount = account;
    globalPublicClient = publicClient;
    globalWalletClient = walletClient;

    log(`✅ Global blockchain clients initialized`);
    log(`🔗 Account: ${account.address}`);
    log(`🏠 Contract: ${globalContractAddress}`);
    return true;
  } catch (error) {
    log(`❌ Failed to initialize global clients: ${error.message}`);
    return false;
  }
}

// Start game server for a specific game
async function startGameServer(gameId) {
  try {
    log(`🚀 Starting game server for game ${gameId}...`, gameId);

    const tooOld = await isGameTooOldToStart(
      gameId,
      globalPublicClient,
      globalContractAddress,
      FULL_CONTRACT_ABI
    );
    if (tooOld) {
      log(
        `⚠️ Game is too old to start - block hash no longer available`,
        gameId
      );
      markGameAsExpired(gameId, gameStates, GamePhase);
      return false;
    }

    const blockHashAvailable = await isBlockHashAvailable(
      gameId,
      globalPublicClient,
      globalContractAddress,
      FULL_CONTRACT_ABI
    );
    if (!blockHashAvailable) {
      log(`⚠️ Block hash not available for game - marking as expired`, gameId);
      markGameAsExpired(gameId, gameStates, GamePhase);
      return false;
    }

    // Check if game is already finished
    let gameAlreadyFinished = false;
    try {
      const scoresFilePath = `${SAVED_DIR}/scores_${gameId}.txt`;
      if (fs.existsSync(scoresFilePath)) {
        const scores = JSON.parse(fs.readFileSync(scoresFilePath, "utf8"));
        const allPlayersFinished = scores.players.every((p) => {
          return (
            p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0)
          );
        });
        if (allPlayersFinished) {
          gameAlreadyFinished = true;
          log(`🏁 Game already finished, keeping scores file`, gameId);
        } else {
          fs.unlinkSync(scoresFilePath);
          log(`🧹 Removed old scores file (game not finished)`, gameId);
        }
      }
    } catch (cleanupError) {
      log(
        `⚠️ Could not check/remove old scores file: ${cleanupError.message}`,
        gameId
      );
    }

    if (gameAlreadyFinished) {
      log(`⏹️ Game ${gameId} already finished, not starting server`, gameId);
      return false;
    }

    // Check if server is already running for this game
    if (activeGameServers.has(gameId)) {
      log(`⚠️ Server already running for game ${gameId}`, gameId);
      return true;
    }

    // Check if reveal file exists
    try {
      const revealValue = loadRevealValue(gameId);
      log(`✅ Found reveal value: ${revealValue.substring(0, 10)}...`, gameId);
    } catch (revealError) {
      log(
        `❌ Cannot start server - missing reveal file: ${revealError.message}`,
        gameId
      );
      return false;
    }

    // Get contract players and map size
    const contractPlayers = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPlayers",
      args: [BigInt(gameId)],
    });

    const gameState = gameStates.get(gameId);
    const contractMapSize =
      gameState && gameState.mapSize > 0
        ? gameState.mapSize
        : 1 + 4 * contractPlayers.length;

    log(`🎮 Generating map for ${contractPlayers.length} players...`, gameId);

    // Calculate random hash and generate map
    const revealValue = loadRevealValue(gameId);
    const randomHash = await calculateRandomHash(
      gameId,
      revealValue,
      globalPublicClient,
      globalContractAddress,
      FULL_CONTRACT_ABI
    );

    const dice = new DeterministicDice(randomHash);
    const mapGenerator = new GameLandGenerator(dice, contractMapSize);
    mapGenerator.generateLand();
    mapGenerator.placeStartingPosition();

    const mapData = {
      size: mapGenerator.size,
      land: mapGenerator.land,
      startingPosition: mapGenerator.startingPosition,
      metadata: {
        generated: new Date().toISOString(),
        gameId: gameId,
        revealValue: revealValue,
        randomHash: randomHash,
      },
    };

    saveGameMap(gameId, mapData);
    log(
      `✅ Map generated successfully: ${mapData.size}x${mapData.size}`,
      gameId
    );

    // Start new server (no need to stop existing servers)
    const serverResult = await initializeGameServer(
      gameId,
      globalPublicClient,
      globalContractAddress
    );

    if (serverResult.server) {
      const port = 8000 + parseInt(gameId);
      activeGameServers.set(gameId, {
        server: serverResult.server,
        isHTTPS: serverResult.isHTTPS,
        port: port,
      });

      log(`✅ Game server started successfully for game ${gameId}!`, gameId);
      log(
        `🌍 Server accessible at ${generateGameServerUrl(
          gameId,
          serverResult.isHTTPS
        )}`,
        gameId
      );

      const currentGameState = gameStates.get(gameId);
      if (currentGameState) {
        currentGameState.phase = GamePhase.GAME_RUNNING;
        gameStates.set(gameId, currentGameState);
        log(`📊 Game phase updated to GAME_RUNNING`, gameId);
      }
      return true;
    } else {
      log(`❌ Failed to start game server`, gameId);
      return false;
    }
  } catch (error) {
    log(`❌ Error starting game server: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);

    if (
      error.message.includes("Commit block hash not available") ||
      error.message.includes("too old")
    ) {
      log(`⚠️ Block hash error detected - marking game as expired`, gameId);
      markGameAsExpired(gameId, gameStates, GamePhase);
    }

    return false;
  }
}

// Stop game server for a specific game
async function stopGameServer(gameId) {
  if (!gameId) {
    log(`⚠️ No gameId provided to stopGameServer`);
    return;
  }

  const serverInfo = activeGameServers.get(gameId);
  if (serverInfo) {
    if (serverInfo.server) {
      serverInfo.server.close();
    }
    activeGameServers.delete(gameId);
    log(`🛑 Game server stopped for game ${gameId}`, gameId);
  }

  // Clean up game server state
  cleanupGameServer(gameId);

  // Clean up timer warning keys for this specific game
  const keysToDelete = [];
  for (const [key, value] of lastWaitingLogs.entries()) {
    if (
      key.startsWith(`timer_warning_${gameId}`) ||
      key.startsWith(`payout_retry_${gameId}`) ||
      key.startsWith(`reveal_retry_${gameId}`) ||
      key.startsWith(`block_hash_waiting_${gameId}`) ||
      key.startsWith(`block_hash_action_${gameId}`) ||
      key.startsWith(`block_hash_start_${gameId}`)
    ) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach((key) => lastWaitingLogs.delete(key));

  // Clean up retry counts for this game
  payoutRetryCount.delete(gameId);
  payoutLastRetryTime.delete(gameId);
  revealRetryCount.delete(gameId);
  revealLastRetryTime.delete(gameId);
}

// Stop all game servers
async function stopAllGameServers() {
  const activeGameIds = Array.from(activeGameServers.keys());
  for (const gameId of activeGameIds) {
    await stopGameServer(gameId);
  }
  log(`🛑 All game servers stopped`);
}

// Monitor game progress wrapper
async function monitorGameProgressWrapper(gameId) {
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
    saveGameScores(gameId, playerData);

    const currentMonitoringGameState = gameStates.get(gameId);
    if (currentMonitoringGameState) {
      currentMonitoringGameState.phase = GamePhase.GAME_FINISHED;
      gameStates.set(gameId, currentMonitoringGameState);
      log(`📊 Game phase updated to GAME_FINISHED`, gameId);
    }
  }

  // Call the generic monitor function
  await monitorGameProgress(
    gameId,
    activeGameServers.has(gameId) ? gameId : null,
    gameStates,
    lastWaitingLogs
  );
}

// Main game loop
async function gameLoop() {
  log(`🔄 Starting game processing loop...`);

  let lastServerStatus = null;
  let lastGameCount = 0;
  let quietCycles = 0;

  while (true) {
    try {
      const gameIds = Array.from(gameStates.keys());

      if (gameIds.length > 0) {
        if (gameIds.length !== lastGameCount || quietCycles > 40) {
          const completedSummary =
            completedGamesCount > 0
              ? ` (${completedGamesCount} completed)`
              : "";
          log(
            `⚙️  Processing ${gameIds.length} active games: [${gameIds.join(
              ", "
            )}]${completedSummary}`
          );
          lastGameCount = gameIds.length;
          quietCycles = 0;
        }

        const sortedGameIds = gameIds.sort((a, b) => {
          const stateA = gameStates.get(a);
          const stateB = gameStates.get(b);

          if (
            stateA?.phase === GamePhase.GAME_RUNNING &&
            stateB?.phase !== GamePhase.GAME_RUNNING
          )
            return -1;
          if (
            stateB?.phase === GamePhase.GAME_RUNNING &&
            stateA?.phase !== GamePhase.GAME_RUNNING
          )
            return 1;

          return parseInt(a) - parseInt(b);
        });

        for (const gameId of sortedGameIds) {
          await processGamePhase(
            gameId,
            gameStates,
            activeGameServers.has(gameId) ? gameId : null,
            globalPublicClient,
            globalWalletClient,
            globalContractAddress,
            lastWaitingLogs,
            payoutRetryCount,
            payoutLastRetryTime,
            revealRetryCount,
            revealLastRetryTime,
            completedGamesCount,
            startGameServer,
            monitorGameProgressWrapper,
            stopGameServer
          );

          // Check if the game was completed and server should be stopped
          if (!gameStates.has(gameId) && activeGameServers.has(gameId)) {
            await stopGameServer(gameId);
          }
        }

        // Generate server status summary
        const activeServers = Array.from(activeGameServers.keys());
        const currentServerStatus =
          activeServers.length > 0
            ? `${activeServers.length} active servers: [${activeServers
                .map((id) => `${id}:${8000 + parseInt(id)}`)
                .join(", ")}]`
            : "No active servers";

        if (currentServerStatus !== lastServerStatus) {
          if (activeServers.length > 0) {
            log(`🖥️  Active game servers: ${currentServerStatus}`);
          } else {
            log(`💤 No active game servers`);
          }
          lastServerStatus = currentServerStatus;
        }
      } else {
        if (quietCycles === 0 || quietCycles % 480 === 0) {
          log(`💤 No games to process, waiting for new games...`);
        }
      }

      quietCycles++;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      log(`❌ Error in game loop: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Main function
async function main() {
  try {
    console.log("\n🎮 AUTOMATED GAME MANAGER");
    console.log("========================");

    const clientsInitialized = await initializeGlobalClients();
    if (!clientsInitialized) {
      console.error("❌ Failed to initialize blockchain clients");
      process.exit(1);
    }

    log(`🎯 Gamemaster account: ${globalAccount.address}`);

    log(`🔍 Scanning for existing games...`);
    const existingGameCount = await scanForExistingGames(
      globalPublicClient,
      globalContractAddress,
      globalAccount,
      gameStates
    );

    if (existingGameCount > 0) {
      log(`📋 Found ${existingGameCount} existing games to manage`);
    } else {
      log(`📭 No existing games found where we are gamemaster`);
    }

    await setupEventListeners(
      globalPublicClient,
      globalContractAddress,
      globalAccount,
      gameStates
    );

    log(`🚀 Starting automated game management...`);
    log(`⏰ Processing games every 250ms...`);
    log(`🔧 Each game will run on port 8000 + gameId`);

    if (gameStates.size > 0) {
      log(
        `🎮 Managing ${gameStates.size} games: [${Array.from(
          gameStates.keys()
        ).join(", ")}]`
      );
    }

    await gameLoop();
  } catch (error) {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  log("🛑 Shutting down gracefully...");

  // Save scores for all active games
  const activeGames = Array.from(activeGameServers.keys());
  for (const gameId of activeGames) {
    try {
      const playerData = getCurrentPlayerData(gameId);
      if (playerData.length > 0) {
        saveGameScores(gameId, playerData);
        log(`💾 Saved final scores for game ${gameId}`);
      }
    } catch (error) {
      log(`Error saving scores for game ${gameId}: ${error.message}`);
    }
  }

  await stopAllGameServers();
  log("👋 Shutdown complete");
  process.exit(0);
});

// Start the system
main().catch((error) => {
  console.error("❌ Failed to start:", error);
  process.exit(1);
});
