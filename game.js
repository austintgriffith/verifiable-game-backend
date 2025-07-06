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
let lastWaitingLogs = new Map(); // Map of gameId -> timestamp of last waiting log
let payoutRetryCount = new Map(); // Map of gameId -> retry count
let payoutLastRetryTime = new Map(); // Map of gameId -> timestamp of last retry
let globalAccount = null;
let globalPublicClient = null;
let globalWalletClient = null;
let globalContractAddress = null;
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

// Helper function to convert BigInt values to numbers for JSON serialization
function safeJsonConvert(obj) {
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

    // Check retry logic
    const retryCount = payoutRetryCount.get(gameId) || 0;
    const lastRetryTime = payoutLastRetryTime.get(gameId) || 0;
    const now = Date.now();
    const MAX_RETRIES = 10;
    const RETRY_BACKOFF_MS = Math.min(
      5000 * Math.pow(2, retryCount - 1),
      300000
    ); // Exponential backoff, max 5 minutes

    if (retryCount >= MAX_RETRIES) {
      log(`❌ Payout failed after ${MAX_RETRIES} retries - giving up`, gameId);
      log(
        `💡 Please manually fund the gamemaster account and restart the service`,
        gameId
      );

      // Move to next phase anyway to prevent infinite loop
      log(
        `⚠️ Skipping to reveal phase due to persistent payout failures`,
        gameId
      );

      // Clean up retry tracking
      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);

      // Update game state to indicate payout was skipped
      const gameState = gameStates.get(gameId);
      if (gameState) {
        gameState.payoutSkipped = true;
        gameState.phase = GamePhase.PAYOUT_COMPLETE;
        gameStates.set(gameId, gameState);
      }

      return true; // Return true to move to next phase
    }

    // Check if we should wait before retrying
    if (retryCount > 0 && now - lastRetryTime < RETRY_BACKOFF_MS) {
      // Still in backoff period, don't retry yet
      return false;
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
      log(
        `✅ Payout successful! Gas used: ${receipt.gasUsed.toString()}`,
        gameId
      );

      // Clear retry tracking on success
      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);

      return true;
    } else {
      log(
        `❌ Payout transaction failed with status: ${receipt.status}`,
        gameId
      );

      // Increment retry count
      payoutRetryCount.set(gameId, retryCount + 1);
      payoutLastRetryTime.set(gameId, now);

      return false;
    }
  } catch (error) {
    const retryCount = payoutRetryCount.get(gameId) || 0;
    const now = Date.now();

    // Check if this is an insufficient funds error
    if (
      error.message.includes("Sender doesn't have enough funds") ||
      error.message.includes("insufficient funds")
    ) {
      log(
        `💰 Insufficient funds for payout (attempt ${retryCount + 1}/${10})`,
        gameId
      );
      log(`💡 Gamemaster account needs more ETH for gas fees`, gameId);

      // Log the specific amounts for debugging
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

      // Use longer backoff for insufficient funds
      const BACKOFF_MS = Math.min(10000 * Math.pow(2, retryCount), 600000); // 10s to 10 minutes
      log(
        `⏳ Will retry in ${Math.round(BACKOFF_MS / 1000)} seconds...`,
        gameId
      );
    } else {
      log(`❌ Error in payout phase: ${error.message}`, gameId);
    }

    // Increment retry count
    payoutRetryCount.set(gameId, retryCount + 1);
    payoutLastRetryTime.set(gameId, now);

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

function shouldLogWaitingMessage(gameId) {
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

  // Determine if we should log this cycle
  const shouldLogThisCycle =
    phaseChanged || needsAction || shouldLogWaitingMessage(gameId);

  // Log state if needed
  if (shouldLogThisCycle) {
    if (phaseChanged || needsAction) {
      logGameState(gameState, true);
    } else {
      logGameState(gameState, false);
    }
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
      // Wait for game to be closed - only log occasionally
      if (shouldLogThisCycle && !needsAction) {
        log(`⏳ Waiting for game to be closed by creator...`, gameId);
      }
      break;

    case GamePhase.CLOSED:
      // Start game server - but only if no other server is running
      if (activeGameServer === gameId) {
        log(`✅ Game server already running for this game`, gameId);
      } else if (activeGameServer !== null) {
        // Another game's server is running, wait our turn
        if (shouldLogThisCycle) {
          log(
            `⏳ Waiting for server slot (Game ${activeGameServer} currently active)`,
            gameId
          );
        }
      } else {
        // No active server, we can start ours
        log(`🎯 Action needed: Start game server`, gameId);
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
          // Still in backoff period
          if (shouldLogThisCycle) {
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
      const payoutSuccess = await payoutGame(gameId);
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
      // Run reveal
      const gameState = gameStates.get(gameId);
      if (gameState && gameState.payoutSkipped) {
        log(`⚠️ Note: Payout was skipped due to insufficient funds`, gameId);
        log(`💡 Winners were not paid out on-chain`, gameId);
      }
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
      // Clean up logging throttle data
      lastWaitingLogs.delete(gameId);
      // Clean up retry tracking data
      payoutRetryCount.delete(gameId);
      payoutLastRetryTime.delete(gameId);
      // Clean up timer warning keys for this game
      const keysToDelete = [];
      for (const [key, value] of lastWaitingLogs.entries()) {
        if (key.startsWith("timer_warning_")) {
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

      // Get players first to determine map size
      const contractPlayers = await globalPublicClient.readContract({
        address: globalContractAddress,
        abi: FULL_CONTRACT_ABI,
        functionName: "getPlayers",
        args: [BigInt(gameId)],
      });

      const calculatedMapSize = MAP_MULTIPLIER * contractPlayers.length;
      log(
        `🗺️ Generating ${calculatedMapSize}x${calculatedMapSize} map for ${contractPlayers.length} players...`,
        gameId
      );

      const dice = new DeterministicDice(revealValue);
      const mapGenerator = new GameLandGenerator(dice, calculatedMapSize);

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

  // Clear game timer
  if (gameTimerInterval) {
    clearTimeout(gameTimerInterval);
    gameTimerInterval = null;
  }
  gameStartTime = null;

  // Clean up timer warning keys when stopping server
  const keysToDelete = [];
  for (const [key, value] of lastWaitingLogs.entries()) {
    if (key.startsWith("timer_warning_")) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach((key) => lastWaitingLogs.delete(key));

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

    // Check if timer has expired
    const timeRemaining = getTimeRemaining();
    if (timeRemaining <= 0 && gameStartTime !== null) {
      log(`⏰ Timer expired! Force finishing game...`, gameId);
      forceFinishGameOnTimer(gameId);
    } else if (gameStartTime !== null) {
      // Log timer warnings at key intervals (but only once per warning)
      const warningTimes = [60, 30, 10, 5];
      const currentTime = Math.floor(timeRemaining);

      if (warningTimes.includes(currentTime)) {
        // Only log if we haven't logged this warning yet (avoid spam)
        const warningKey = `timer_warning_${currentTime}`;
        if (!lastWaitingLogs.has(warningKey)) {
          log(`⏰ Timer warning: ${currentTime} seconds remaining!`, gameId);
          lastWaitingLogs.set(warningKey, Date.now());
        }
      }
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

      // Clear the timer since game is finished
      if (gameTimerInterval) {
        clearInterval(gameTimerInterval);
        gameTimerInterval = null;
      }

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

// Timer state
let gameStartTime = null;
let gameTimerDuration = 90; // 90 seconds
let gameTimerInterval = null;

// Debug flag - SET TO FALSE TO DISABLE HEAVY DEBUGGING
const heavyDebug = true; // Set to false to disable heavy debugging
// This will log detailed information about player positions, movements, and API responses

// Game constants
const MAP_MULTIPLIER = 4;
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

function getCurrentMapSize() {
  // If we have a loaded game map, use its size
  if (gameMap && gameMap.size) {
    return gameMap.size;
  }
  // Otherwise calculate based on current player count
  const playerCount = players.length;
  return playerCount > 0 ? MAP_MULTIPLIER * playerCount : MAP_MULTIPLIER;
}

function wrapCoordinate(coord, mapSize = null) {
  const size = mapSize || getCurrentMapSize();
  const result = ((coord % size) + size) % size;

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] wrapCoordinate: coord=${coord}, size=${size}, result=${result}`,
      currentGameId
    );
  }

  return result;
}

function generateStartingPosition(playerAddress, gameId) {
  const combined = revealSeed + playerAddress.toLowerCase() + gameId.toString();
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  const xHex = hash.substring(0, 8);
  const yHex = hash.substring(8, 16);
  const mapSize = getCurrentMapSize();
  const x = parseInt(xHex, 16) % mapSize;
  const y = parseInt(yHex, 16) % mapSize;

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] generateStartingPosition for ${playerAddress}: combined=${combined.substring(
        0,
        20
      )}..., hash=${hash.substring(
        0,
        20
      )}..., xHex=${xHex}, yHex=${yHex}, mapSize=${mapSize}, result={x:${x}, y:${y}}`,
      gameId
    );
  }

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

function getSanitizedPlayerData(gameId) {
  const playerData = [];
  players.forEach((address) => {
    const stats = playerStats.get(address.toLowerCase());
    if (stats) {
      playerData.push({
        address,
        score: stats.score,
        movesRemaining: stats.movesRemaining,
        minesRemaining: stats.minesRemaining,
      });
    }
  });
  return playerData;
}

function getTimeRemaining() {
  if (!gameStartTime) return 0;
  const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
  return Math.max(0, gameTimerDuration - elapsed);
}

function forceFinishGameOnTimer(gameId) {
  log(`⏰ Timer expired! Force finishing game ${gameId}...`, gameId);

  // Log current player stats before forcing finish
  const playerData = getCurrentPlayerData(gameId);
  log(`📊 Game ending due to timer - Current player stats:`, gameId);
  playerData.forEach((player, index) => {
    log(`  Player ${index + 1}: ${player.address}`, gameId);
    log(
      `    Score: ${player.score}, Moves: ${player.movesRemaining}, Mines: ${player.minesRemaining}`,
      gameId
    );
  });

  // Set all players' moves and mines to 0
  players.forEach((address) => {
    const stats = playerStats.get(address.toLowerCase());
    if (stats) {
      stats.movesRemaining = 0;
      stats.minesRemaining = 0;
      playerStats.set(address.toLowerCase(), stats);
    }
  });

  log(
    `🏁 All players' moves and mines set to 0 due to timer expiration`,
    gameId
  );

  // Clear the timer
  if (gameTimerInterval) {
    clearTimeout(gameTimerInterval);
    gameTimerInterval = null;
  }

  // The game will be detected as finished in the next monitoring cycle
}

async function loadPlayersFromContract(gameId) {
  try {
    const contractPlayers = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getPlayers",
      args: [BigInt(gameId)],
    });

    if (heavyDebug) {
      log(
        `🔍 [DEBUG] loadPlayersFromContract: Found ${
          contractPlayers.length
        } players: ${JSON.stringify(contractPlayers)}`,
        gameId
      );
    }

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

      if (heavyDebug) {
        log(
          `🔍 [DEBUG] loadPlayersFromContract: Set ${playerAddress} at position ${JSON.stringify(
            startPos
          )} with stats {score:0, moves:${MAX_MOVES}, mines:${MAX_MINES}}`,
          gameId
        );
      }
    });

    if (heavyDebug) {
      log(
        `🔍 [DEBUG] loadPlayersFromContract: Final playerPositions map: ${JSON.stringify(
          Object.fromEntries(playerPositions)
        )}`,
        gameId
      );
      log(
        `🔍 [DEBUG] loadPlayersFromContract: Final playerStats map: ${JSON.stringify(
          Object.fromEntries(playerStats)
        )}`,
        gameId
      );
    }

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

// Override Express JSON response to handle BigInt values
app.set("json replacer", function (key, value) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
});

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
      if (heavyDebug) {
        log(
          `🔍 [DEBUG] authenticateToken: Player ${
            decoded.address
          } is not valid. Current players: ${JSON.stringify(players)}`,
          currentGameId
        );
      }
      return res.status(403).json({ error: "Player no longer registered" });
    }

    req.playerAddress = decoded.address;

    if (heavyDebug) {
      log(
        `🔍 [DEBUG] authenticateToken: Authenticated player ${decoded.address}`,
        currentGameId
      );
    }

    next();
  });
}

// Game logic functions
function getLocalMapView(playerAddress) {
  const position = playerPositions.get(playerAddress.toLowerCase());
  if (!position) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] getLocalMapView: No position found for ${playerAddress}`,
        currentGameId
      );
    }
    return null;
  }

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] getLocalMapView for ${playerAddress}: position=${JSON.stringify(
        position
      )}, mapSize=${gameMap.size}`,
      currentGameId
    );
  }

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

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] getLocalMapView result: localView=${JSON.stringify(
        localView
      )}, position=${JSON.stringify(position)}, mapSize=${gameMap.size}`,
      currentGameId
    );
  }

  return { view: localView, position, mapSize: gameMap.size };
}

function movePlayer(playerAddress, direction) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] movePlayer: No position found for ${playerAddress}`,
        currentGameId
      );
    }
    return { success: false, error: "Player not found" };
  }

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] movePlayer: No stats found for ${playerAddress}`,
        currentGameId
      );
    }
    return { success: false, error: "Player stats not found" };
  }

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] movePlayer for ${playerAddress}: direction=${direction}, currentPos=${JSON.stringify(
        currentPos
      )}, stats=${JSON.stringify(stats)}`,
      currentGameId
    );
  }

  if (stats.movesRemaining <= 0)
    return { success: false, error: "No moves remaining" };

  const dirVector = DIRECTIONS[direction.toLowerCase()];
  if (!dirVector) return { success: false, error: "Invalid direction" };

  const newX = wrapCoordinate(currentPos.x + dirVector.x, gameMap.size);
  const newY = wrapCoordinate(currentPos.y + dirVector.y, gameMap.size);

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] movePlayer calculation: dirVector=${JSON.stringify(
        dirVector
      )}, newX=${newX}, newY=${newY}, mapSize=${gameMap.size}`,
      currentGameId
    );
  }

  playerPositions.set(playerAddress.toLowerCase(), { x: newX, y: newY });
  stats.movesRemaining--;
  playerStats.set(playerAddress.toLowerCase(), stats);

  const result = {
    success: true,
    newPosition: { x: newX, y: newY },
    tile: gameMap.land[newY][newX],
    movesRemaining: stats.movesRemaining,
    minesRemaining: stats.minesRemaining,
    score: stats.score,
  };

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] movePlayer result: ${JSON.stringify(result)}`,
      currentGameId
    );
  }

  return result;
}

function minePlayer(playerAddress) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] minePlayer: No position found for ${playerAddress}`,
        currentGameId
      );
    }
    return { success: false, error: "Player not found" };
  }

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] minePlayer: No stats found for ${playerAddress}`,
        currentGameId
      );
    }
    return { success: false, error: "Player stats not found" };
  }

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] minePlayer for ${playerAddress}: currentPos=${JSON.stringify(
        currentPos
      )}, stats=${JSON.stringify(stats)}`,
      currentGameId
    );
  }

  if (stats.minesRemaining <= 0)
    return { success: false, error: "No mines remaining" };

  const currentTile = gameMap.land[currentPos.y][currentPos.x];
  if (currentTile === 0) return { success: false, error: "Tile already mined" };

  const pointsEarned = TILE_POINTS[currentTile] || 0;
  stats.score += pointsEarned;
  stats.minesRemaining--;
  playerStats.set(playerAddress.toLowerCase(), stats);

  gameMap.land[currentPos.y][currentPos.x] = 0;

  const result = {
    success: true,
    position: currentPos,
    tile: currentTile,
    pointsEarned,
    totalScore: stats.score,
    minesRemaining: stats.minesRemaining,
    movesRemaining: stats.movesRemaining,
  };

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] minePlayer result: ${JSON.stringify(result)}`,
      currentGameId
    );
  }

  return result;
}

// API Routes
app.get("/", (req, res) => {
  const timeRemaining = getTimeRemaining();
  const gameActive = gameStartTime !== null;

  res.json({
    success: true,
    message: "Automated Game Server",
    version: "2.0.0",
    gameId: currentGameId,
    activeGames: safeJsonConvert(Array.from(gameStates.keys())),
    serverStatus: "running",
    mapSize: getCurrentMapSize(),
    mapMultiplier: MAP_MULTIPLIER,
    playerCount: players.length,
    timestamp: new Date().toISOString(),
    timer: {
      active: gameActive,
      duration: gameTimerDuration,
      timeRemaining: timeRemaining,
    },
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
    mapSize: getCurrentMapSize(),
    mapMultiplier: MAP_MULTIPLIER,
  });
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
  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /map endpoint called by ${req.playerAddress}`,
      currentGameId
    );
  }

  const localView = getLocalMapView(req.playerAddress);
  if (!localView) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] /map: localView is null for ${req.playerAddress}`,
        currentGameId
      );
    }
    return res.status(404).json({ error: "Player not found" });
  }

  const stats = playerStats.get(req.playerAddress.toLowerCase());
  const timeRemaining = getTimeRemaining();

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /map: stats=${JSON.stringify(
        stats
      )}, timeRemaining=${timeRemaining}`,
      currentGameId
    );
  }

  const response = {
    success: true,
    player: req.playerAddress,
    localView: localView.view,
    position: localView.position,
    mapSize: localView.mapSize,
    score: stats ? stats.score : 0,
    movesRemaining: stats ? stats.movesRemaining : 0,
    minesRemaining: stats ? stats.minesRemaining : 0,
    timeRemaining: timeRemaining,
    legend: {
      0: "Depleted (already mined)",
      1: "Common (1 point)",
      2: "Uncommon (5 points)",
      3: "Rare (10 points)",
      X: "Treasure!!! (25 points)",
    },
  };

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /map response for ${req.playerAddress}: ${JSON.stringify(
        response
      )}`,
      currentGameId
    );
  }

  res.json(response);
});

app.post("/move", authenticateToken, (req, res) => {
  const { direction } = req.body;
  if (!direction) {
    return res.status(400).json({ error: "Direction required" });
  }

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /move endpoint called by ${req.playerAddress}, direction=${direction}`,
      currentGameId
    );
  }

  const timeRemaining = getTimeRemaining();
  if (timeRemaining <= 0) {
    return res.status(400).json({ error: "Time expired! Game over." });
  }

  const moveResult = movePlayer(req.playerAddress, direction);
  if (!moveResult.success) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] /move: movePlayer failed for ${req.playerAddress}: ${moveResult.error}`,
        currentGameId
      );
    }
    return res.status(400).json({ error: moveResult.error });
  }

  const localView = getLocalMapView(req.playerAddress);

  const response = {
    success: true,
    player: req.playerAddress,
    direction,
    newPosition: moveResult.newPosition,
    tile: moveResult.tile,
    localView: localView.view,
    score: moveResult.score,
    movesRemaining: moveResult.movesRemaining,
    minesRemaining: moveResult.minesRemaining,
    timeRemaining: timeRemaining,
    validDirections: Object.keys(DIRECTIONS),
  };

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /move response for ${req.playerAddress}: ${JSON.stringify(
        response
      )}`,
      currentGameId
    );
  }

  res.json(response);
});

app.post("/mine", authenticateToken, (req, res) => {
  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /mine endpoint called by ${req.playerAddress}`,
      currentGameId
    );
  }

  const timeRemaining = getTimeRemaining();
  if (timeRemaining <= 0) {
    return res.status(400).json({ error: "Time expired! Game over." });
  }

  const mineResult = minePlayer(req.playerAddress);
  if (!mineResult.success) {
    if (heavyDebug) {
      log(
        `🔍 [DEBUG] /mine: minePlayer failed for ${req.playerAddress}: ${mineResult.error}`,
        currentGameId
      );
    }
    return res.status(400).json({ error: mineResult.error });
  }

  const localView = getLocalMapView(req.playerAddress);

  const response = {
    success: true,
    player: req.playerAddress,
    position: mineResult.position,
    tile: mineResult.tile,
    pointsEarned: mineResult.pointsEarned,
    totalScore: mineResult.totalScore,
    movesRemaining: mineResult.movesRemaining,
    minesRemaining: mineResult.minesRemaining,
    timeRemaining: timeRemaining,
    localView: localView.view,
  };

  if (heavyDebug) {
    log(
      `🔍 [DEBUG] /mine response for ${req.playerAddress}: ${JSON.stringify(
        response
      )}`,
      currentGameId
    );
  }

  res.json(response);
});

app.get("/status", (req, res) => {
  const timeRemaining = getTimeRemaining();
  const gameActive = gameStartTime !== null;

  // Get retry information for debugging
  const retryInfo = {};
  for (const [gameId, count] of payoutRetryCount.entries()) {
    const lastRetry = payoutLastRetryTime.get(gameId) || 0;
    const now = Date.now();
    const backoffMs = Math.min(5000 * Math.pow(2, count - 1), 300000);
    const timeUntilRetry = Math.max(0, backoffMs - (now - lastRetry));

    retryInfo[gameId] = {
      retryCount: count,
      maxRetries: 10,
      timeUntilRetry: Math.round(timeUntilRetry / 1000),
      lastRetryTime: new Date(lastRetry).toISOString(),
    };
  }

  // Convert game states to safe JSON format (handling BigInt values)
  const safeGameStates = Object.fromEntries(
    Array.from(gameStates.entries()).map(([id, state]) => [
      id,
      safeJsonConvert({
        phase: state.phase,
        payoutSkipped: state.payoutSkipped || false,
        playerCount: state.playerCount,
        stakeAmount: state.stakeAmount,
        hasOpened: state.hasOpened,
        hasClosed: state.hasClosed,
        hasCommitted: state.hasCommitted,
        hasRevealed: state.hasRevealed,
        hasPaidOut: state.hasPaidOut,
      }),
    ])
  );

  res.json({
    success: true,
    gameId: currentGameId,
    activeGames: Array.from(gameStates.keys()),
    gameLoaded: gameMap !== null,
    mapSize: getCurrentMapSize(),
    mapMultiplier: MAP_MULTIPLIER,
    totalPlayers: players.length,
    players,
    serverTime: new Date().toISOString(),
    timer: {
      active: gameActive,
      duration: gameTimerDuration,
      timeRemaining: timeRemaining,
      timeElapsed: gameActive ? gameTimerDuration - timeRemaining : 0,
      startTime: gameStartTime,
    },
    retryInfo: retryInfo,
    gameStates: safeGameStates,
  });
});

app.get("/players", (req, res) => {
  const playerData = getSanitizedPlayerData(currentGameId);
  const timeRemaining = getTimeRemaining();

  res.json({
    success: true,
    gameId: currentGameId,
    players: playerData,
    count: playerData.length,
    timeRemaining: timeRemaining,
    mapSize: getCurrentMapSize(),
    mapMultiplier: MAP_MULTIPLIER,
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

    // Start the game timer
    gameStartTime = Date.now();
    log(
      `⏰ Game timer started - players have ${gameTimerDuration} seconds`,
      gameId
    );

    // Set up timer to force finish game after duration
    gameTimerInterval = setTimeout(() => {
      if (activeGameServer === gameId) {
        log(`⏰ Timer expired! Auto-finishing game ${gameId}`, gameId);
        forceFinishGameOnTimer(gameId);
      }
    }, gameTimerDuration * 1000);

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

        // Process games in order, prioritizing running games first
        const sortedGameIds = gameIds.sort((a, b) => {
          const stateA = gameStates.get(a);
          const stateB = gameStates.get(b);

          // Running games get highest priority
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

          // Then by game ID (lower numbers first)
          return parseInt(a) - parseInt(b);
        });

        for (const gameId of sortedGameIds) {
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
