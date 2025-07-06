import express from "express";
import fs from "fs";
import https from "https";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createClients, createPublicClientForChain } from "./clients.js";
import { verifyMessage, keccak256, toBytes, toHex } from "viem";
import { DeterministicDice, GameLandGenerator } from "./generateMap.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// ===============================
// AUTOMATED GAME MANAGER SYSTEM
// ===============================

// File system constants
const SAVED_DIR = "saved";

// Ensure saved directory exists
function ensureSavedDirectory() {
  if (!fs.existsSync(SAVED_DIR)) {
    fs.mkdirSync(SAVED_DIR, { recursive: true });
    log(`📁 Created saved directory: ${SAVED_DIR}`);
  }
}

// Game phases enum
const GamePhase = {
  CREATED: "CREATED", // Game created, need to commit
  COMMITTED: "COMMITTED", // Hash committed, waiting for close
  CLOSED: "CLOSED", // Game closed, need to start server
  GAME_RUNNING: "GAME_RUNNING", // Game server running
  GAME_FINISHED: "GAME_FINISHED", // All players done, need payout
  PAYOUT_COMPLETE: "PAYOUT_COMPLETE", // Payout done, need reveal
  COMPLETE: "COMPLETE", // Reveal done, fully complete
};

// Global state
let gameStates = new Map(); // Map of gameId -> game state
let activeGameServer = null;
let currentGameId = null;
let expressApp = null;
let httpServer = null;
let httpsServer = null;

// Global blockchain clients (created once at startup)
let globalAccount = null;
let globalPublicClient = null;
let globalWalletClient = null;
let globalContractAddress = null;

// Game statistics
let completedGamesCount = 0;

// Contract ABIs
const FULL_CONTRACT_ABI = [
  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "gameId", type: "uint256" },
      { indexed: true, name: "gamemaster", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "stakeAmount", type: "uint256" },
    ],
    name: "GameCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: "gameId", type: "uint256" }],
    name: "GameClosed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "gameId", type: "uint256" },
      { indexed: true, name: "player", type: "address" },
    ],
    name: "PlayerJoined",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "gameId", type: "uint256" },
      { indexed: true, name: "committedHash", type: "bytes32" },
      { indexed: false, name: "nextBlockNumber", type: "uint256" },
    ],
    name: "HashCommitted",
    type: "event",
  },
  // Contract functions
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
    name: "getPlayers",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getCommitRevealState",
    outputs: [
      { name: "_committedHash", type: "bytes32" },
      { name: "_commitBlockNumber", type: "uint256" },
      { name: "_revealValue", type: "bytes32" },
      { name: "_randomHash", type: "bytes32" },
      { name: "_hasCommitted", type: "bool" },
      { name: "_hasRevealed", type: "bool" },
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
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "_hash", type: "bytes32" },
    ],
    name: "commitHash",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "_reveal", type: "bytes32" },
    ],
    name: "revealHash",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
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
];

// ===========================
// CLIENT INITIALIZATION
// ===========================

async function initializeGlobalClients() {
  try {
    // Get contract address from environment
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

// ===========================
// UTILITY FUNCTIONS
// ===========================

function log(message, gameId = null) {
  const timestamp = new Date().toISOString();
  const prefix = gameId ? `[Game ${gameId}]` : `[System]`;
  console.log(`${timestamp} ${prefix} ${message}`);
}

function generateRandomReveal() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return toHex(randomBytes);
}

function saveRevealValue(gameId, revealValue) {
  ensureSavedDirectory();
  const filePath = `${SAVED_DIR}/reveal_${gameId}.txt`;
  fs.writeFileSync(filePath, revealValue);
  log(`Saved reveal value to ${filePath}`, gameId);
}

function loadRevealValue(gameId) {
  try {
    const filePath = `${SAVED_DIR}/reveal_${gameId}.txt`;
    const revealValue = fs.readFileSync(filePath, "utf8").trim();
    log(`Loaded reveal value from ${filePath}`, gameId);
    return revealValue;
  } catch (error) {
    throw new Error(
      `Failed to load ${SAVED_DIR}/reveal_${gameId}.txt: ${error.message}`
    );
  }
}

function saveGameMap(gameId, mapData) {
  ensureSavedDirectory();
  const filePath = `${SAVED_DIR}/map_${gameId}.txt`;
  fs.writeFileSync(filePath, JSON.stringify(mapData, null, 2));
  log(`Saved map to ${filePath}`, gameId);
}

function loadGameMap(gameId) {
  try {
    const filePath = `${SAVED_DIR}/map_${gameId}.txt`;
    const mapData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    log(`Loaded ${mapData.size}x${mapData.size} map from ${filePath}`, gameId);
    return mapData;
  } catch (error) {
    throw new Error(
      `Failed to load ${SAVED_DIR}/map_${gameId}.txt: ${error.message}`
    );
  }
}

function saveGameScores(gameId, playerData) {
  const scoresData = {
    gameId: gameId,
    players: playerData,
    count: playerData.length,
    savedAt: new Date().toISOString(),
  };
  ensureSavedDirectory();
  const filePath = `${SAVED_DIR}/scores_${gameId}.txt`;
  fs.writeFileSync(filePath, JSON.stringify(scoresData, null, 2));
  log(`Saved final scores to ${filePath}`, gameId);
}

function loadGameScores(gameId) {
  try {
    const filePath = `${SAVED_DIR}/scores_${gameId}.txt`;
    const scoresData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    log(`Loaded scores from ${filePath}`, gameId);
    return scoresData.players;
  } catch (error) {
    throw new Error(
      `Failed to load ${SAVED_DIR}/scores_${gameId}.txt: ${error.message}`
    );
  }
}

// ===========================
// CONTRACT INTERACTION
// ===========================

async function commitHashForGame(gameId) {
  try {
    log(`Starting commit phase...`, gameId);

    // Check current state
    const currentState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, , , , hasCommitted] = currentState;
    if (hasCommitted) {
      log(`Hash already committed for game ${gameId}`, gameId);
      return true;
    }

    // Generate random reveal value
    const revealBytes32 = generateRandomReveal();
    log(`Generated reveal value: ${revealBytes32}`, gameId);

    // Hash the reveal value
    const commitHash = keccak256(toBytes(revealBytes32));
    log(`Generated commit hash: ${commitHash}`, gameId);

    // Save reveal value
    saveRevealValue(gameId, revealBytes32);

    // Commit the hash
    log(`Committing hash to contract...`, gameId);
    const commitTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "commitHash",
      args: [BigInt(gameId), commitHash],
    });

    log(`Commit transaction: ${commitTxHash}`, gameId);

    // Wait for confirmation
    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: commitTxHash,
    });

    if (receipt.status === "success") {
      log(`Commit successful! Gas used: ${receipt.gasUsed.toString()}`, gameId);
      return true;
    } else {
      log(`Commit failed!`, gameId);
      return false;
    }
  } catch (error) {
    log(`Error in commit phase: ${error.message}`, gameId);
    return false;
  }
}

async function payoutGame(gameId) {
  try {
    log(`Starting payout phase...`, gameId);

    // Check if already paid out
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

    // Load player scores
    const playerScores = loadGameScores(gameId);
    if (playerScores.length === 0) {
      log(`No players found for payout`, gameId);
      return false;
    }

    // Find winners (highest score)
    const highestScore = Math.max(...playerScores.map((p) => p.score));
    const winners = playerScores
      .filter((p) => p.score === highestScore)
      .map((p) => p.address);

    log(`Found ${winners.length} winner(s) with score ${highestScore}`, gameId);
    winners.forEach((winner, index) => {
      log(`Winner ${index + 1}: ${winner}`, gameId);
    });

    // Execute payout
    log(`Executing payout...`, gameId);
    const payoutTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "payout",
      args: [BigInt(gameId), winners],
    });

    log(`Payout transaction: ${payoutTxHash}`, gameId);

    // Wait for confirmation
    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: payoutTxHash,
    });

    if (receipt.status === "success") {
      log(`Payout successful! Gas used: ${receipt.gasUsed.toString()}`, gameId);
      return true;
    } else {
      log(`Payout failed!`, gameId);
      return false;
    }
  } catch (error) {
    log(`Error in payout phase: ${error.message}`, gameId);
    return false;
  }
}

async function revealGame(gameId) {
  try {
    log(`Starting reveal phase...`, gameId);

    // Check current state
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

    // Load reveal value
    const revealValue = loadRevealValue(gameId);

    // Reveal the hash
    log(`Revealing hash...`, gameId);
    const revealTxHash = await globalWalletClient.writeContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "revealHash",
      args: [BigInt(gameId), revealValue],
    });

    log(`Reveal transaction: ${revealTxHash}`, gameId);

    // Wait for confirmation
    const receipt = await globalPublicClient.waitForTransactionReceipt({
      hash: revealTxHash,
    });

    if (receipt.status === "success") {
      log(`Reveal successful! Gas used: ${receipt.gasUsed.toString()}`, gameId);

      // Get final state to show random hash
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
      log(`Reveal failed!`, gameId);
      return false;
    }
  } catch (error) {
    log(`Error in reveal phase: ${error.message}`, gameId);
    return false;
  }
}

// ===========================
// GAME STATE MANAGEMENT
// ===========================

async function updateGameState(gameId) {
  try {
    // Get game info
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

    // Get commit-reveal state
    const commitState = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitRevealState",
      args: [BigInt(gameId)],
    });

    const [, , , , hasCommitted, hasRevealed] = commitState;

    // Get payout state
    const payoutInfo = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPayoutInfo",
      args: [BigInt(gameId)],
    });

    const [, , hasPaidOut] = payoutInfo;

    // Determine current phase
    let phase = GamePhase.CREATED;
    if (hasRevealed) {
      phase = GamePhase.COMPLETE;
    } else if (hasPaidOut) {
      phase = GamePhase.PAYOUT_COMPLETE;
    } else if (hasClosed && hasCommitted) {
      // Game is closed and committed, check if it's already finished
      try {
        const playerScores = loadGameScores(gameId);
        const allPlayersFinished = playerScores.every((p) => {
          // Player is finished if:
          // 1. No mines left (can't mine anymore), OR
          // 2. No moves left AND standing on depleted tile (can't mine current square)
          return (
            p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0)
          );
        });
        if (allPlayersFinished) {
          phase = GamePhase.GAME_FINISHED;
        } else if (activeGameServer === gameId) {
          // Game not finished but server running
          phase = GamePhase.GAME_RUNNING;
        } else {
          // Game not finished and no server, need to start it
          phase = GamePhase.CLOSED;
        }
      } catch (error) {
        // No scores file yet, check if server is running
        if (activeGameServer === gameId) {
          phase = GamePhase.GAME_RUNNING;
        } else {
          // No scores file and no server, need to start it
          phase = GamePhase.CLOSED;
        }
      }
    } else if (hasCommitted) {
      phase = GamePhase.COMMITTED;
    }

    // Update game state
    const currentState = gameStates.get(gameId) || {};
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
      hasPaidOut,
      phase,
      lastUpdated: Date.now(),
    });

    return gameStates.get(gameId);
  } catch (error) {
    log(`Error updating game state: ${error.message}`, gameId);
    return null;
  }
}

function logGameState(gameState, verbose = false) {
  const gameId = gameState.gameId;

  if (verbose) {
    log(`📊 Game State:`, gameId);
    log(`  Phase: ${gameState.phase}`, gameId);
    log(`  Has Opened: ${gameState.hasOpened}`, gameId);
    log(`  Has Closed: ${gameState.hasClosed}`, gameId);
    log(`  Has Committed: ${gameState.hasCommitted}`, gameId);
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
    // Concise logging - only show important info
    log(
      `📊 ${gameState.phase} | Players: ${gameState.playerCount} | Server: ${
        activeGameServer === gameId ? "YES" : "NO"
      }`,
      gameId
    );
  }
}

async function processGamePhase(gameId) {
  const gameState = await updateGameState(gameId);
  if (!gameState) {
    log(`❌ Could not update game state`, gameId);
    return;
  }

  // Check if phase changed to decide on verbose logging
  const lastState = gameStates.get(gameId);
  const phaseChanged = !lastState || lastState.phase !== gameState.phase;
  const needsAction = [
    GamePhase.CREATED,
    GamePhase.CLOSED,
    GamePhase.GAME_FINISHED,
    GamePhase.PAYOUT_COMPLETE,
  ].includes(gameState.phase);

  // Log state (verbose if phase changed or action needed)
  if (phaseChanged || needsAction) {
    logGameState(gameState, true);
  } else {
    logGameState(gameState, false);
  }

  switch (gameState.phase) {
    case GamePhase.CREATED:
      // Need to commit hash
      log(`🎯 Action needed: Commit hash`, gameId);
      const commitSuccess = await commitHashForGame(gameId);
      if (commitSuccess) {
        log(`✅ Commit phase completed`, gameId);
      } else {
        log(`❌ Commit phase failed`, gameId);
      }
      break;

    case GamePhase.COMMITTED:
      // Wait for game to be closed
      log(`⏳ Waiting for game to be closed by creator...`, gameId);
      break;

    case GamePhase.CLOSED:
      // Start game server
      log(`🎯 Action needed: Start game server`, gameId);
      if (activeGameServer === gameId) {
        log(`✅ Game server already running for this game`, gameId);
      } else {
        const serverStarted = await startGameServer(gameId);
        if (!serverStarted) {
          // Game was already finished, update phase
          const gameState = gameStates.get(gameId);
          if (gameState) {
            gameState.phase = GamePhase.GAME_FINISHED;
            gameStates.set(gameId, gameState);
            log(
              `📊 Game phase updated to GAME_FINISHED (already completed)`,
              gameId
            );
          }
        }
      }
      break;

    case GamePhase.GAME_RUNNING:
      // Monitor game progress and auto-finish when players are done
      await monitorGameProgress(gameId);
      break;

    case GamePhase.GAME_FINISHED:
      // Run payout
      log(`🎯 Action needed: Execute payout`, gameId);
      const payoutSuccess = await payoutGame(gameId);
      if (payoutSuccess) {
        log(`✅ Payout phase completed`, gameId);
      } else {
        log(`❌ Payout phase failed`, gameId);
      }
      break;

    case GamePhase.PAYOUT_COMPLETE:
      // Run reveal
      log(`🎯 Action needed: Reveal hash`, gameId);
      const revealSuccess = await revealGame(gameId);
      if (revealSuccess) {
        log(`✅ Reveal phase completed`, gameId);

        // Schedule delayed shutdown of game server to give frontend time to finish
        log(`⏲️ Scheduling game server shutdown in 10 seconds...`, gameId);
        setTimeout(() => {
          if (activeGameServer === gameId) {
            log(
              `🛑 Delayed shutdown: Stopping game server for completed game ${gameId}`,
              gameId
            );
            stopGameServer();
          } else {
            log(
              `⏭️ Skipping delayed shutdown - different game server now active`,
              gameId
            );
          }
        }, 10000); // 10 second delay
      } else {
        log(`❌ Reveal phase failed`, gameId);
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
      break;

    default:
      log(`❓ Unknown game phase: ${gameState.phase}`, gameId);
      break;
  }
}

// ===========================
// GAME SERVER MANAGEMENT
// ===========================

async function startGameServer(gameId) {
  try {
    log(`🚀 Starting game server for game ${gameId}...`, gameId);

    // Check if game is already finished (has completed scores)
    let gameAlreadyFinished = false;
    try {
      const scoresFilePath = `${SAVED_DIR}/scores_${gameId}.txt`;
      if (fs.existsSync(scoresFilePath)) {
        const scores = loadGameScores(gameId);
        const allPlayersFinished = scores.every((p) => {
          // Player is finished if:
          // 1. No mines left (can't mine anymore), OR
          // 2. No moves left AND standing on depleted tile (can't mine current square)
          return (
            p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0)
          );
        });
        if (allPlayersFinished) {
          gameAlreadyFinished = true;
          log(`🏁 Game already finished, keeping scores file`, gameId);
        } else {
          // Game in progress, remove old scores to start fresh
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

    // If game is already finished, don't start server
    if (gameAlreadyFinished) {
      log(`⏹️ Game ${gameId} already finished, not starting server`, gameId);
      return false;
    }

    // Check if reveal file exists
    log(`🔍 Checking for reveal file...`, gameId);
    try {
      const revealValue = loadRevealValue(gameId);
      log(`✅ Found reveal value: ${revealValue.substring(0, 10)}...`, gameId);

      // Generate map using reveal seed
      log(`🗺️ Generating game map...`, gameId);
      const dice = new DeterministicDice(revealValue);
      const mapGenerator = new GameLandGenerator(dice);

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
        },
      };

      saveGameMap(gameId, mapData);
      log(`✅ Map generated: ${mapData.size}x${mapData.size}`, gameId);

      // Stop current server if running
      if (activeGameServer) {
        log(`🛑 Stopping current server for game ${activeGameServer}`, gameId);
        await stopGameServer();
      }

      // Start new server for this game
      log(`🌐 Initializing HTTP server...`, gameId);
      const serverStarted = await initializeGameServer(gameId);

      if (serverStarted) {
        activeGameServer = gameId;
        currentGameId = gameId;
        log(`✅ Game server started successfully for game ${gameId}!`, gameId);
        log(`🌍 Server accessible at http://localhost:8000`, gameId);
        log(`🎮 Players can now access the game!`, gameId);

        // Update game state to GAME_RUNNING
        const gameState = gameStates.get(gameId);
        if (gameState) {
          gameState.phase = GamePhase.GAME_RUNNING;
          gameStates.set(gameId, gameState);
          log(`📊 Game phase updated to GAME_RUNNING`, gameId);
        }
        return true;
      } else {
        log(`❌ Failed to start game server`, gameId);
        return false;
      }
    } catch (revealError) {
      log(
        `❌ Cannot start server - reveal file missing: ${revealError.message}`,
        gameId
      );
      log(`💡 Make sure the commit phase completed successfully`, gameId);
      return false;
    }
  } catch (error) {
    log(`❌ Error starting game server: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);
    return false;
  }
}

async function stopGameServer() {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (httpsServer) {
    httpsServer.close();
    httpsServer = null;
  }
  if (activeGameServer) {
    log(`Game server stopped for game ${activeGameServer}`, activeGameServer);
    activeGameServer = null;
    currentGameId = null;
  }
}

async function monitorGameProgress(gameId) {
  try {
    // Only monitor if this game's server is running
    if (activeGameServer !== gameId) {
      log(`⚠️ Cannot monitor - server not running for this game`, gameId);
      return;
    }

    // Check if all players have finished
    const playerData = getCurrentPlayerData(gameId);

    if (playerData.length === 0) {
      log(`⚠️ No player data available yet`, gameId);
      return;
    }

    const allPlayersFinished = playerData.every((p) => {
      // Player is finished if:
      // 1. No mines left (can't mine anymore), OR
      // 2. No moves left AND standing on depleted tile (can't mine current square)
      return p.minesRemaining === 0 || (p.movesRemaining === 0 && p.tile === 0);
    });

    if (allPlayersFinished) {
      log(`🏁 All players finished! Saving final scores...`, gameId);

      // Log final player stats
      log(`📊 Final Results:`, gameId);
      playerData.forEach((player, index) => {
        log(`  Player ${index + 1}: ${player.address}`, gameId);
        log(
          `    Score: ${player.score}, Moves: ${player.movesRemaining}, Mines: ${player.minesRemaining}, Current tile: ${player.tile}`,
          gameId
        );
      });

      saveGameScores(gameId, playerData);

      // Keep server running for now - will stop it later after payout/reveal
      log(`🌐 Keeping game server running for payout/reveal phase...`, gameId);

      // Update game state
      const gameState = gameStates.get(gameId);
      if (gameState) {
        gameState.phase = GamePhase.GAME_FINISHED;
        gameStates.set(gameId, gameState);
        log(`📊 Game phase updated to GAME_FINISHED`, gameId);
      }

      log(`✅ Game completed, ready for payout`, gameId);
    }
    // Don't log "Game still in progress" every 3 seconds - too noisy
  } catch (error) {
    log(`❌ Error monitoring game progress: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);
  }
}

// ===========================
// EVENT LISTENING & GAME DISCOVERY
// ===========================

async function scanForExistingGames() {
  try {
    log(`🔍 Scanning for existing games where we are gamemaster...`);

    // Get all GameCreated events from the beginning
    const gameCreatedEvents = await globalPublicClient.getContractEvents({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameCreated",
      args: {
        gamemaster: globalAccount.address,
      },
      fromBlock: 0n,
      toBlock: "latest",
    });

    log(`📋 Found ${gameCreatedEvents.length} existing games`);

    // Process each game
    for (const event of gameCreatedEvents) {
      const gameId = event.args.gameId.toString();
      const gamemaster = event.args.gamemaster;
      const creator = event.args.creator;
      const stakeAmount = event.args.stakeAmount;

      log(`📋 Processing existing game ${gameId}`, gameId);
      log(`  Gamemaster: ${gamemaster}`, gameId);
      log(`  Creator: ${creator}`, gameId);
      log(`  Stake: ${Number(stakeAmount) / 1e18} ETH`, gameId);

      // Add to our managed games
      gameStates.set(gameId, {
        gameId,
        gamemaster,
        creator,
        stakeAmount,
        phase: GamePhase.CREATED, // Will be updated when we check state
        lastUpdated: Date.now(),
      });
    }

    log(`✅ Scanned and loaded ${gameCreatedEvents.length} existing games`);
    return gameCreatedEvents.length;
  } catch (error) {
    log(`❌ Error scanning for existing games: ${error.message}`);
    return 0;
  }
}

async function setupEventListeners() {
  try {
    log(`📡 Setting up event listeners...`);
    log(
      `🎯 Listening for games where we are gamemaster: ${globalAccount.address}`
    );

    // Listen for GameCreated events (new games)
    const unsubscribeGameCreated = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameCreated",
      args: {
        gamemaster: globalAccount.address,
      },
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const gamemaster = eventLog.args.gamemaster;
          const creator = eventLog.args.creator;
          const stakeAmount = eventLog.args.stakeAmount;

          log(`🎮 NEW game created! Game ID: ${gameId}`, gameId);
          log(`  Gamemaster: ${gamemaster}`, gameId);
          log(`  Creator: ${creator}`, gameId);
          log(`  Stake: ${Number(stakeAmount) / 1e18} ETH`, gameId);

          // Add to our managed games
          gameStates.set(gameId, {
            gameId,
            gamemaster,
            creator,
            stakeAmount,
            phase: GamePhase.CREATED,
            lastUpdated: Date.now(),
          });
        });
      },
    });

    // Listen for GameClosed events
    const unsubscribeGameClosed = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameClosed",
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const gameState = gameStates.get(gameId);

          if (gameState) {
            log(`🔒 Game closed! Game ID: ${gameId}`, gameId);
            gameState.phase = GamePhase.CLOSED;
            gameState.lastUpdated = Date.now();
            gameStates.set(gameId, gameState);
          }
        });
      },
    });

    // Listen for HashCommitted events (to track our commits)
    const unsubscribeHashCommitted = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "HashCommitted",
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const gameState = gameStates.get(gameId);

          if (gameState) {
            log(`📝 Hash committed for game ${gameId}`, gameId);
            gameState.phase = GamePhase.COMMITTED;
            gameState.lastUpdated = Date.now();
            gameStates.set(gameId, gameState);
          }
        });
      },
    });

    log(`✅ Event listeners set up successfully`);
    return [
      unsubscribeGameCreated,
      unsubscribeGameClosed,
      unsubscribeHashCommitted,
    ];
  } catch (error) {
    log(`❌ Error setting up event listeners: ${error.message}`);
    return [];
  }
}

// ===========================
// GAME SERVER LOGIC
// ===========================

const app = express();

// JWT Configuration
const BASE_JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-this-in-production";
const JWT_EXPIRES_IN = "1h";

// Game server state
let gameMap = null;
let players = [];
let playerPositions = new Map();
let playerStats = new Map();
let revealSeed = null;

// Game constants
const MAX_MOVES = 12;
const MAX_MINES = 3;
const TILE_POINTS = {
  0: 0, // Depleted
  1: 1, // Common
  2: 5, // Uncommon
  3: 10, // Rare
  X: 25, // Starting position (ultra rare)
};

const DIRECTIONS = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
  northeast: { x: 1, y: -1 },
  northwest: { x: -1, y: -1 },
  southeast: { x: 1, y: 1 },
  southwest: { x: -1, y: 1 },
};

// Helper functions
function getJWTSecret() {
  if (!globalContractAddress) {
    throw new Error("Contract address not initialized");
  }
  return BASE_JWT_SECRET + "-" + globalContractAddress.toLowerCase();
}

function generateSignMessage(gameId, providedTimestamp = null) {
  const timestamp = providedTimestamp || Date.now();
  return `Sign this message to authenticate with the game server.\n\nContract: ${globalContractAddress}\nGameId: ${gameId}\nNamespace: ScriptGame\nTimestamp: ${timestamp}\n\nThis signature is valid for 5 minutes.`;
}

function isValidPlayer(address) {
  return players.some(
    (player) => player.toLowerCase() === address.toLowerCase()
  );
}

function wrapCoordinate(coord, mapSize) {
  return ((coord % mapSize) + mapSize) % mapSize;
}

function generateStartingPosition(playerAddress, gameId) {
  const combined = revealSeed + playerAddress.toLowerCase() + gameId.toString();
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  const xHex = hash.substring(0, 8);
  const yHex = hash.substring(8, 16);
  const x = parseInt(xHex, 16) % gameMap.size;
  const y = parseInt(yHex, 16) % gameMap.size;
  return { x, y };
}

function getCurrentPlayerData(gameId) {
  const playerData = [];
  players.forEach((address) => {
    const position = playerPositions.get(address.toLowerCase());
    const stats = playerStats.get(address.toLowerCase());
    if (position && stats) {
      playerData.push({
        address,
        position,
        tile: gameMap.land[position.y][position.x],
        score: stats.score,
        movesRemaining: stats.movesRemaining,
        minesRemaining: stats.minesRemaining,
      });
    }
  });
  return playerData;
}

async function loadPlayersFromContract(gameId) {
  try {
    const contractPlayers = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPlayers",
      args: [BigInt(gameId)],
    });

    players = contractPlayers;
    playerPositions.clear();
    playerStats.clear();

    contractPlayers.forEach((playerAddress) => {
      const startPos = generateStartingPosition(playerAddress, gameId);
      playerPositions.set(playerAddress.toLowerCase(), startPos);
      playerStats.set(playerAddress.toLowerCase(), {
        score: 0,
        movesRemaining: MAX_MOVES,
        minesRemaining: MAX_MINES,
      });
    });

    log(`Loaded ${contractPlayers.length} players from contract`, gameId);
    return true;
  } catch (error) {
    log(`Error loading players: ${error.message}`, gameId);
    return false;
  }
}

// Express middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  jwt.verify(token, getJWTSecret(), (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }

    if (!isValidPlayer(decoded.address)) {
      return res.status(403).json({ error: "Player no longer registered" });
    }

    req.playerAddress = decoded.address;
    next();
  });
}

// Game logic functions
function getLocalMapView(playerAddress) {
  const position = playerPositions.get(playerAddress.toLowerCase());
  if (!position) return null;

  const localView = [];
  const { x: centerX, y: centerY } = position;

  for (let dy = -1; dy <= 1; dy++) {
    const row = [];
    for (let dx = -1; dx <= 1; dx++) {
      const mapX = wrapCoordinate(centerX + dx, gameMap.size);
      const mapY = wrapCoordinate(centerY + dy, gameMap.size);
      const tile = gameMap.land[mapY][mapX];

      if (dx === 0 && dy === 0) {
        row.push({ tile, player: true, coordinates: { x: mapX, y: mapY } });
      } else {
        row.push({ tile, player: false, coordinates: { x: mapX, y: mapY } });
      }
    }
    localView.push(row);
  }

  return { view: localView, position, mapSize: gameMap.size };
}

function movePlayer(playerAddress, direction) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) return { success: false, error: "Player not found" };

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) return { success: false, error: "Player stats not found" };

  if (stats.movesRemaining <= 0)
    return { success: false, error: "No moves remaining" };

  const dirVector = DIRECTIONS[direction.toLowerCase()];
  if (!dirVector) return { success: false, error: "Invalid direction" };

  const newX = wrapCoordinate(currentPos.x + dirVector.x, gameMap.size);
  const newY = wrapCoordinate(currentPos.y + dirVector.y, gameMap.size);

  playerPositions.set(playerAddress.toLowerCase(), { x: newX, y: newY });
  stats.movesRemaining--;
  playerStats.set(playerAddress.toLowerCase(), stats);

  return {
    success: true,
    newPosition: { x: newX, y: newY },
    tile: gameMap.land[newY][newX],
    movesRemaining: stats.movesRemaining,
    minesRemaining: stats.minesRemaining,
    score: stats.score,
  };
}

function minePlayer(playerAddress) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) return { success: false, error: "Player not found" };

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) return { success: false, error: "Player stats not found" };

  if (stats.minesRemaining <= 0)
    return { success: false, error: "No mines remaining" };

  const currentTile = gameMap.land[currentPos.y][currentPos.x];
  if (currentTile === 0) return { success: false, error: "Tile already mined" };

  const pointsEarned = TILE_POINTS[currentTile] || 0;
  stats.score += pointsEarned;
  stats.minesRemaining--;
  playerStats.set(playerAddress.toLowerCase(), stats);

  gameMap.land[currentPos.y][currentPos.x] = 0;

  return {
    success: true,
    position: currentPos,
    tile: currentTile,
    pointsEarned,
    totalScore: stats.score,
    minesRemaining: stats.minesRemaining,
    movesRemaining: stats.movesRemaining,
  };
}

// API Routes
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Automated Game Server",
    version: "2.0.0",
    gameId: currentGameId,
    activeGames: Array.from(gameStates.keys()),
    serverStatus: "running",
    timestamp: new Date().toISOString(),
    endpoints: {
      register: "/register",
      map: "/map (requires auth)",
      move: "/move (requires auth)",
      mine: "/mine (requires auth)",
      status: "/status",
      players: "/players",
      test: "/test",
    },
  });
});

// Test endpoint to verify server is working
app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Server is running!",
    gameId: currentGameId,
    timestamp: new Date().toISOString(),
    gameLoaded: gameMap !== null,
    playersCount: players.length,
  });
});

// Force finish game endpoint (for debugging)
app.post("/admin/finish", (req, res) => {
  if (!currentGameId) {
    return res.status(400).json({ error: "No active game" });
  }

  try {
    const playerData = getCurrentPlayerData(currentGameId);
    saveGameScores(currentGameId, playerData);

    // Update game state
    const gameState = gameStates.get(currentGameId);
    if (gameState) {
      gameState.phase = GamePhase.GAME_FINISHED;
      gameStates.set(currentGameId, gameState);
    }

    log(
      `🏁 Game ${currentGameId} manually finished via admin endpoint`,
      currentGameId
    );

    res.json({
      success: true,
      message: "Game finished manually",
      gameId: currentGameId,
      players: playerData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/register", (req, res) => {
  const timestamp = Date.now();
  const message = generateSignMessage(currentGameId, timestamp);

  res.json({
    success: true,
    message,
    timestamp,
    gameId: currentGameId,
    instructions: "Sign this message with your Ethereum wallet to authenticate",
  });
});

app.post("/register", async (req, res) => {
  const { signature, address, timestamp } = req.body;

  if (!signature || !address || !timestamp) {
    return res.status(400).json({
      error: "Signature, address, and timestamp are required",
    });
  }

  if (!isValidPlayer(address)) {
    return res.status(403).json({
      error: "Address is not registered as a player",
    });
  }

  try {
    const message = generateSignMessage(currentGameId, parseInt(timestamp));
    const isValid = await verifyMessage({
      address,
      message,
      signature,
    });

    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const tokenPayload = {
      address: address.toLowerCase(),
      timestamp: Date.now(),
    };

    const token = jwt.sign(tokenPayload, getJWTSecret(), {
      expiresIn: JWT_EXPIRES_IN,
    });

    res.json({
      success: true,
      token,
      expiresIn: JWT_EXPIRES_IN,
      message: "Authentication successful",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to verify signature" });
  }
});

app.get("/map", authenticateToken, (req, res) => {
  const localView = getLocalMapView(req.playerAddress);
  if (!localView) {
    return res.status(404).json({ error: "Player not found" });
  }

  const stats = playerStats.get(req.playerAddress.toLowerCase());

  res.json({
    success: true,
    player: req.playerAddress,
    localView: localView.view,
    position: localView.position,
    mapSize: localView.mapSize,
    score: stats ? stats.score : 0,
    movesRemaining: stats ? stats.movesRemaining : 0,
    minesRemaining: stats ? stats.minesRemaining : 0,
    legend: {
      0: "Depleted (already mined)",
      1: "Common (1 point)",
      2: "Uncommon (5 points)",
      3: "Rare (10 points)",
      X: "Treasure!!! (25 points)",
    },
  });
});

app.post("/move", authenticateToken, (req, res) => {
  const { direction } = req.body;
  if (!direction) {
    return res.status(400).json({ error: "Direction required" });
  }

  const moveResult = movePlayer(req.playerAddress, direction);
  if (!moveResult.success) {
    return res.status(400).json({ error: moveResult.error });
  }

  const localView = getLocalMapView(req.playerAddress);

  res.json({
    success: true,
    player: req.playerAddress,
    direction,
    newPosition: moveResult.newPosition,
    tile: moveResult.tile,
    localView: localView.view,
    score: moveResult.score,
    movesRemaining: moveResult.movesRemaining,
    minesRemaining: moveResult.minesRemaining,
    validDirections: Object.keys(DIRECTIONS),
  });
});

app.post("/mine", authenticateToken, (req, res) => {
  const mineResult = minePlayer(req.playerAddress);
  if (!mineResult.success) {
    return res.status(400).json({ error: mineResult.error });
  }

  const localView = getLocalMapView(req.playerAddress);

  res.json({
    success: true,
    player: req.playerAddress,
    position: mineResult.position,
    tile: mineResult.tile,
    pointsEarned: mineResult.pointsEarned,
    totalScore: mineResult.totalScore,
    movesRemaining: mineResult.movesRemaining,
    minesRemaining: mineResult.minesRemaining,
    localView: localView.view,
  });
});

app.get("/status", (req, res) => {
  res.json({
    success: true,
    gameId: currentGameId,
    activeGames: Array.from(gameStates.keys()),
    gameLoaded: gameMap !== null,
    mapSize: gameMap ? gameMap.size : null,
    totalPlayers: players.length,
    players,
    revealSeed,
    serverTime: new Date().toISOString(),
  });
});

app.get("/players", (req, res) => {
  const playerData = getCurrentPlayerData(currentGameId);
  res.json({
    success: true,
    gameId: currentGameId,
    players: playerData,
    count: playerData.length,
  });
});

async function initializeGameServer(gameId) {
  try {
    log(`🔧 Initializing game server for game ${gameId}...`, gameId);

    // Load game data
    log(`📂 Loading game map...`, gameId);
    gameMap = loadGameMap(gameId);
    log(`✅ Game map loaded: ${gameMap.size}x${gameMap.size}`, gameId);

    log(`🔑 Loading reveal seed...`, gameId);
    revealSeed = loadRevealValue(gameId);
    log(`✅ Reveal seed loaded: ${revealSeed.substring(0, 10)}...`, gameId);

    // Load players
    log(`👥 Loading players from contract...`, gameId);
    const playersLoaded = await loadPlayersFromContract(gameId);
    if (!playersLoaded) {
      log(`❌ Failed to load players from contract`, gameId);
      return false;
    }
    log(`✅ Loaded ${players.length} players`, gameId);

    // Start server
    const PORT = 8000;
    const hasSSL = fs.existsSync("server.key") && fs.existsSync("server.cert");
    log(`🔒 SSL available: ${hasSSL}`, gameId);

    return new Promise((resolve) => {
      if (hasSSL) {
        try {
          log(`🔐 Setting up HTTPS server...`, gameId);
          const httpsOptions = {
            key: fs.readFileSync("server.key"),
            cert: fs.readFileSync("server.cert"),
          };
          httpsServer = https.createServer(httpsOptions, app);
          httpsServer.listen(PORT, "0.0.0.0", () => {
            log(`🚀 HTTPS Game Server running on port ${PORT}`, gameId);
            log(`🌍 Access at: https://localhost:${PORT}`, gameId);
            resolve(true);
          });
          httpsServer.on("error", (error) => {
            log(`❌ HTTPS server error: ${error.message}`, gameId);
            resolve(false);
          });
        } catch (error) {
          log(
            `❌ SSL setup failed, falling back to HTTP: ${error.message}`,
            gameId
          );
          httpServer = app.listen(PORT, "0.0.0.0", () => {
            log(`🚀 HTTP Game Server running on port ${PORT}`, gameId);
            log(`🌍 Access at: http://localhost:${PORT}`, gameId);
            resolve(true);
          });
          httpServer.on("error", (error) => {
            log(`❌ HTTP server error: ${error.message}`, gameId);
            resolve(false);
          });
        }
      } else {
        log(`🌐 Setting up HTTP server...`, gameId);
        httpServer = app.listen(PORT, "0.0.0.0", () => {
          log(`🚀 HTTP Game Server running on port ${PORT}`, gameId);
          log(`🌍 Access at: http://localhost:${PORT}`, gameId);
          resolve(true);
        });
        httpServer.on("error", (error) => {
          log(`❌ HTTP server error: ${error.message}`, gameId);
          resolve(false);
        });
      }
    });
  } catch (error) {
    log(`❌ Error initializing game server: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);
    return false;
  }
}

// ===========================
// MAIN SYSTEM LOOP
// ===========================

async function gameLoop() {
  log(`🔄 Starting game processing loop...`);

  let lastServerStatus = null;
  let lastGameCount = 0;
  let quietCycles = 0;

  while (true) {
    try {
      // Process all active games
      const gameIds = Array.from(gameStates.keys());

      if (gameIds.length > 0) {
        // Only log processing info occasionally or when count changes
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

        for (const gameId of gameIds) {
          await processGamePhase(gameId);
        }

        // Only log server status when it changes
        const currentServerStatus = activeGameServer
          ? `Game ${activeGameServer} on port 8000`
          : "No active server";
        if (currentServerStatus !== lastServerStatus) {
          if (activeGameServer) {
            log(`🖥️  Active game server: ${currentServerStatus}`);
          } else {
            log(`💤 No active game server`);
          }
          lastServerStatus = currentServerStatus;
        }
      } else {
        // Only log waiting message occasionally (every 2 minutes = 480 cycles * 250ms)
        if (quietCycles === 0 || quietCycles % 480 === 0) {
          log(`💤 No games to process, waiting for new games...`);
        }
      }

      quietCycles++;

      // Wait before next iteration
      await new Promise((resolve) => setTimeout(resolve, 250)); // 250ms delay
    } catch (error) {
      log(`❌ Error in game loop: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay on error
    }
  }
}

async function main() {
  try {
    console.log("\n🎮 AUTOMATED GAME MANAGER");
    console.log("========================");

    // Initialize global blockchain clients (including contract address validation)
    const clientsInitialized = await initializeGlobalClients();
    if (!clientsInitialized) {
      console.error("❌ Failed to initialize blockchain clients");
      process.exit(1);
    }

    log(`🎯 Gamemaster account: ${globalAccount.address}`);

    // Scan for existing games first
    log(`🔍 Scanning for existing games...`);
    const existingGameCount = await scanForExistingGames();

    if (existingGameCount > 0) {
      log(`📋 Found ${existingGameCount} existing games to manage`);
    } else {
      log(`📭 No existing games found where we are gamemaster`);
    }

    // Set up event listeners for new games
    await setupEventListeners();

    // Start game loop
    log(`🚀 Starting automated game management...`);
    log(`⏰ Processing games every 250ms...`);

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

  // Save any active game scores
  if (currentGameId && players.length > 0) {
    try {
      const playerData = getCurrentPlayerData(currentGameId);
      saveGameScores(currentGameId, playerData);
      log(`💾 Saved final scores for game ${currentGameId}`);
    } catch (error) {
      log(`Error saving scores: ${error.message}`);
    }
  }

  // Stop servers
  await stopGameServer();

  log("👋 Shutdown complete");
  process.exit(0);
});

// Start the system
main().catch((error) => {
  console.error("❌ Failed to start:", error);
  process.exit(1);
});
