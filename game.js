import express from "express";
import fs from "fs";
import crypto from "crypto";
import { createPublicClientForChain } from "./clients.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Contract ABI for reading players
const GAME_MANAGEMENT_ABI = [
  {
    inputs: [],
    name: "getPlayers",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPlayerCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// Game state
let gameMap = null;
let players = [];
let playerPositions = new Map(); // Map of address -> {x, y}
let revealSeed = null;

// Direction mappings for movement
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

// Load game map from file
function loadGameMap() {
  try {
    const mapData = JSON.parse(fs.readFileSync("map.txt", "utf8"));
    gameMap = mapData;
    console.log(`✅ Loaded ${mapData.size}x${mapData.size} game map`);
    return true;
  } catch (error) {
    console.error("❌ Failed to load map.txt:", error.message);
    return false;
  }
}

// Load reveal seed from file
function loadRevealSeed() {
  try {
    revealSeed = fs.readFileSync("reveal.txt", "utf8").trim();
    console.log(`✅ Loaded reveal seed: ${revealSeed}`);
    return true;
  } catch (error) {
    console.error("❌ Failed to load reveal.txt:", error.message);
    return false;
  }
}

// Generate starting position for a player based on reveal seed + address
function generateStartingPosition(playerAddress) {
  // Combine reveal seed with player address
  const combined = revealSeed + playerAddress.toLowerCase();

  // Hash the combination
  const hash = crypto.createHash("sha256").update(combined).digest("hex");

  // Use first 8 characters for x, next 8 for y
  const xHex = hash.substring(0, 8);
  const yHex = hash.substring(8, 16);

  // Convert to integers and mod by map size (20)
  const x = parseInt(xHex, 16) % gameMap.size;
  const y = parseInt(yHex, 16) % gameMap.size;

  return { x, y };
}

// Read players from smart contract
async function loadPlayers() {
  try {
    const contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("CONTRACT_ADDRESS not found in .env file");
    }

    const publicClient = createPublicClientForChain();

    // Get players array from contract
    const contractPlayers = await publicClient.readContract({
      address: contractAddress,
      abi: GAME_MANAGEMENT_ABI,
      functionName: "getPlayers",
    });

    console.log(`✅ Loaded ${contractPlayers.length} players from contract`);

    // Generate starting positions for each player
    players = contractPlayers;
    playerPositions.clear();

    contractPlayers.forEach((playerAddress) => {
      const startPos = generateStartingPosition(playerAddress);
      playerPositions.set(playerAddress.toLowerCase(), startPos);
      console.log(
        `🎯 Player ${playerAddress}: starting at (${startPos.x}, ${startPos.y})`
      );
    });

    return true;
  } catch (error) {
    console.error("❌ Failed to load players:", error.message);
    return false;
  }
}

// Get 3x3 local map view for a player
function getLocalMapView(playerAddress) {
  const position = playerPositions.get(playerAddress.toLowerCase());
  if (!position) {
    return null;
  }

  const localView = [];
  const { x: centerX, y: centerY } = position;

  // Create 3x3 grid centered on player with wrapping
  for (let dy = -1; dy <= 1; dy++) {
    const row = [];
    for (let dx = -1; dx <= 1; dx++) {
      // Use wrapping for coordinates
      const mapX = wrapCoordinate(centerX + dx, gameMap.size);
      const mapY = wrapCoordinate(centerY + dy, gameMap.size);

      const tile = gameMap.land[mapY][mapX];
      // Add player marker in center
      if (dx === 0 && dy === 0) {
        row.push({ tile, player: true, coordinates: { x: mapX, y: mapY } });
      } else {
        row.push({ tile, player: false, coordinates: { x: mapX, y: mapY } });
      }
    }
    localView.push(row);
  }

  return {
    view: localView,
    position: position,
    mapSize: gameMap.size,
  };
}

// Helper function to wrap coordinates around the map
function wrapCoordinate(coord, mapSize) {
  return ((coord % mapSize) + mapSize) % mapSize;
}

// Move player in a direction
function movePlayer(playerAddress, direction) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    return { success: false, error: "Player not found" };
  }

  const dirVector = DIRECTIONS[direction.toLowerCase()];
  if (!dirVector) {
    return { success: false, error: "Invalid direction" };
  }

  // Calculate new position with wrapping
  const newX = wrapCoordinate(currentPos.x + dirVector.x, gameMap.size);
  const newY = wrapCoordinate(currentPos.y + dirVector.y, gameMap.size);

  // Update position
  playerPositions.set(playerAddress.toLowerCase(), { x: newX, y: newY });

  return {
    success: true,
    newPosition: { x: newX, y: newY },
    tile: gameMap.land[newY][newX],
  };
}

// API Routes

// GET /map/:address - Get 3x3 local map view for player
app.get("/map/:address", (req, res) => {
  const playerAddress = req.params.address;

  if (!playerAddress) {
    return res.status(400).json({ error: "Player address required" });
  }

  const localView = getLocalMapView(playerAddress);
  if (!localView) {
    return res.status(404).json({ error: "Player not found" });
  }

  res.json({
    success: true,
    player: playerAddress,
    localView: localView.view,
    position: localView.position,
    mapSize: localView.mapSize,
    legend: {
      1: "Common",
      2: "Uncommon",
      3: "Rare",
      X: "Starting Position",
    },
  });
});

// POST /move/:address - Move player in specified direction
app.post("/move/:address", (req, res) => {
  const playerAddress = req.params.address;
  const { direction } = req.body;

  if (!playerAddress) {
    return res.status(400).json({ error: "Player address required" });
  }

  if (!direction) {
    return res.status(400).json({ error: "Direction required" });
  }

  const moveResult = movePlayer(playerAddress, direction);

  if (!moveResult.success) {
    return res.status(400).json({ error: moveResult.error });
  }

  // Return updated local view after move
  const localView = getLocalMapView(playerAddress);

  res.json({
    success: true,
    player: playerAddress,
    direction: direction,
    newPosition: moveResult.newPosition,
    tile: moveResult.tile,
    localView: localView.view,
    validDirections: Object.keys(DIRECTIONS),
  });
});

// GET /status - Get game status
app.get("/status", (req, res) => {
  res.json({
    success: true,
    gameLoaded: gameMap !== null,
    mapSize: gameMap ? gameMap.size : null,
    totalPlayers: players.length,
    players: players,
    revealSeed: revealSeed,
    serverTime: new Date().toISOString(),
  });
});

// GET /players - Get all player positions
app.get("/players", (req, res) => {
  const playerData = [];

  players.forEach((address) => {
    const position = playerPositions.get(address.toLowerCase());
    if (position) {
      playerData.push({
        address: address,
        position: position,
        tile: gameMap.land[position.y][position.x],
      });
    }
  });

  res.json({
    success: true,
    players: playerData,
    count: playerData.length,
  });
});

// Initialize and start server
async function initializeGame() {
  console.log("\n🎮 Initializing Game Server");
  console.log("============================");

  // Load game map
  if (!loadGameMap()) {
    console.error("❌ Failed to initialize: Could not load map");
    process.exit(1);
  }

  // Load reveal seed
  if (!loadRevealSeed()) {
    console.error("❌ Failed to initialize: Could not load reveal seed");
    process.exit(1);
  }

  // Load players from contract
  if (!(await loadPlayers())) {
    console.error("❌ Failed to initialize: Could not load players");
    process.exit(1);
  }

  const PORT = 8000;

  app.listen(PORT, () => {
    console.log(`\n🚀 Game API Server running on port ${PORT}`);
    console.log(`📊 Map size: ${gameMap.size}x${gameMap.size}`);
    console.log(`👥 Players loaded: ${players.length}`);
    console.log(`🔑 Reveal seed: ${revealSeed.substring(0, 10)}...`);
    console.log("\n📡 API Endpoints:");
    console.log(
      `GET  http://localhost:${PORT}/map/:address     - Get 3x3 local view`
    );
    console.log(`POST http://localhost:${PORT}/move/:address    - Move player`);
    console.log(`GET  http://localhost:${PORT}/status           - Game status`);
    console.log(
      `GET  http://localhost:${PORT}/players          - All player positions`
    );
    console.log("\n✅ Server ready!");
  });
}

// Start the server
initializeGame().catch((error) => {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
