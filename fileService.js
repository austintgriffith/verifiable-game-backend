import fs from "fs";
import crypto from "crypto";
import { toHex, keccak256, toBytes, concat } from "viem";
import { SAVED_DIR } from "./constants.js";
import { log } from "./utils.js";

// Ensure saved directory exists
export function ensureSavedDirectory() {
  if (!fs.existsSync(SAVED_DIR)) {
    fs.mkdirSync(SAVED_DIR, { recursive: true });
    log(`📁 Created saved directory: ${SAVED_DIR}`);
  }
}

// Generate random reveal value
export function generateRandomReveal() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return toHex(randomBytes);
}

// Save reveal value to file
export function saveRevealValue(gameId, revealValue) {
  ensureSavedDirectory();
  const filePath = `${SAVED_DIR}/reveal_${gameId}.txt`;
  fs.writeFileSync(filePath, revealValue);
  log(`Saved reveal value to ${filePath}`, gameId);
}

// Load reveal value from file
export function loadRevealValue(gameId) {
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

// Calculate random hash from game data
export async function calculateRandomHash(
  gameId,
  revealValue,
  globalPublicClient,
  globalContractAddress,
  FULL_CONTRACT_ABI
) {
  try {
    log(`Calculating random hash for game ${gameId}...`, gameId);

    const commitBlockHash = await globalPublicClient.readContract({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      functionName: "getCommitBlockHash",
      args: [BigInt(gameId)],
    });

    log(`Retrieved commit block hash: ${commitBlockHash}`, gameId);
    log(`Using reveal value: ${revealValue.substring(0, 10)}...`, gameId);

    const randomHash = keccak256(concat([commitBlockHash, revealValue]));

    log(`Calculated random hash: ${randomHash}`, gameId);
    log(`This should match the contract's randomHash when revealed`, gameId);

    return randomHash;
  } catch (error) {
    throw new Error(
      `Failed to calculate random hash for game ${gameId}: ${error.message}`
    );
  }
}

// Save game map to file
export function saveGameMap(gameId, mapData) {
  ensureSavedDirectory();
  const filePath = `${SAVED_DIR}/map_${gameId}.txt`;
  fs.writeFileSync(filePath, JSON.stringify(mapData, null, 2));
  log(`Saved map to ${filePath}`, gameId);
}

// Load game map from file
export function loadGameMap(gameId) {
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

// Save final game scores to file
export function saveGameScores(gameId, playerData) {
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

// Load game scores from file
export function loadGameScores(gameId) {
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
