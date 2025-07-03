import express from "express";
import fs from "fs";
import https from "https";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createPublicClientForChain } from "./clients.js";
import { verifyMessage } from "viem";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();

// JWT Configuration
const BASE_JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-this-in-production";
const JWT_EXPIRES_IN = "1h";

// Make JWT secret contract-specific by including contract address
function getJWTSecret() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) {
    throw new Error("CONTRACT_ADDRESS not found in .env file");
  }
  // Combine base secret with contract address to make it contract-specific
  return BASE_JWT_SECRET + "-" + contractAddress.toLowerCase();
}

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
let playerStats = new Map(); // Map of address -> {score, movesRemaining, minesRemaining}
let revealSeed = null;

// Game constants
const MAX_MOVES = 12;
const MAX_MINES = 3;

// SSL Detection
function checkSSLCredentials() {
  try {
    return fs.existsSync("server.key") && fs.existsSync("server.cert");
  } catch (error) {
    console.log("🔍 SSL credential check failed:", error.message);
    return false;
  }
}

// Scoring system based on land types
const TILE_POINTS = {
  0: 0, // Depleted (already mined) = 0 points
  1: 1, // Common = 1 point
  2: 5, // Uncommon = 5 points
  3: 10, // Rare = 10 points
};

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

// Authentication helpers
function generateSignMessage(providedTimestamp = null) {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const timestamp = providedTimestamp || Date.now();

  const message = `Sign this message to authenticate with the game server.\n\nContract: ${contractAddress}\nNamespace: ScriptGame\nTimestamp: ${timestamp}\n\nThis signature is valid for 5 minutes.`;

  console.log("📝 generateSignMessage() called");
  console.log("   - Contract:", contractAddress);
  console.log("   - Timestamp:", timestamp);
  console.log("   - Provided timestamp:", providedTimestamp);
  console.log("   - Message length:", message.length);

  return message;
}

function isValidPlayer(address) {
  return players.some(
    (player) => player.toLowerCase() === address.toLowerCase()
  );
}

// Authentication middleware
function authenticateToken(req, res, next) {
  console.log(`\n🔑 Authenticating request to ${req.method} ${req.path}`);

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  console.log("📋 Auth header:", authHeader ? "Bearer [token]" : "MISSING");
  console.log(
    "🎫 Token (first 20 chars):",
    token ? token.substring(0, 20) + "..." : "NONE"
  );

  if (!token) {
    console.log("❌ No token provided");
    return res.status(401).json({ error: "Access token required" });
  }

  jwt.verify(token, getJWTSecret(), (err, decoded) => {
    if (err) {
      console.log("❌ JWT verification failed:", err.message);
      return res.status(403).json({ error: "Invalid or expired token" });
    }

    console.log("✅ JWT verified successfully");
    console.log("📋 Decoded token:", decoded);

    // Verify the address is still a valid player
    if (!isValidPlayer(decoded.address)) {
      console.log("❌ Player no longer registered:", decoded.address);
      return res.status(403).json({ error: "Player no longer registered" });
    }

    console.log("✅ Player still registered:", decoded.address);
    req.playerAddress = decoded.address;
    next();
  });
}

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
    playerStats.clear();

    contractPlayers.forEach((playerAddress) => {
      const startPos = generateStartingPosition(playerAddress);
      playerPositions.set(playerAddress.toLowerCase(), startPos);

      // Initialize player stats
      playerStats.set(playerAddress.toLowerCase(), {
        score: 0,
        movesRemaining: MAX_MOVES,
        minesRemaining: MAX_MINES,
      });

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

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    return { success: false, error: "Player stats not found" };
  }

  // Check if player has moves remaining
  if (stats.movesRemaining <= 0) {
    return { success: false, error: "No moves remaining" };
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

  // Decrement moves remaining
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

// Mine at current player position
function minePlayer(playerAddress) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    return { success: false, error: "Player not found" };
  }

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    return { success: false, error: "Player stats not found" };
  }

  // Check if player has mines remaining
  if (stats.minesRemaining <= 0) {
    return { success: false, error: "No mines remaining" };
  }

  // Get current tile and calculate points
  const currentTile = gameMap.land[currentPos.y][currentPos.x];

  // Check if tile is already depleted (0 = already mined)
  if (currentTile === 0) {
    return { success: false, error: "Tile already mined" };
  }

  const pointsEarned = TILE_POINTS[currentTile] || 0;

  // Update player stats
  stats.score += pointsEarned;
  stats.minesRemaining--;
  playerStats.set(playerAddress.toLowerCase(), stats);

  // Deplete the tile (set to 0) after mining
  gameMap.land[currentPos.y][currentPos.x] = 0;

  return {
    success: true,
    position: currentPos,
    tile: currentTile,
    pointsEarned: pointsEarned,
    totalScore: stats.score,
    minesRemaining: stats.minesRemaining,
    movesRemaining: stats.movesRemaining,
  };
}

// API Routes

// GET / - Welcome message
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Welcome to the Verifiable Game Backend!",
    version: "1.0.0",
    endpoints: {
      register: "/register",
      map: "/map (requires auth)",
      move: "/move (requires auth)",
      mine: "/mine (requires auth)",
      status: "/status",
      players: "/players"
    }
  });
});

// GET /register - Get message to sign for authentication
app.get("/register", (req, res) => {
  const timestamp = Date.now();
  const message = generateSignMessage(timestamp);

  console.log("\n🔐 GET /register - Generating sign message");
  console.log("📝 Message to sign:", message);
  console.log("📍 Contract address:", process.env.CONTRACT_ADDRESS);

  res.json({
    success: true,
    message: message,
    timestamp: timestamp,
    instructions: "Sign this message with your Ethereum wallet to authenticate",
  });
});

// POST /register - Verify signature and issue JWT token
app.post("/register", async (req, res) => {
  const { signature, address, timestamp } = req.body;

  console.log("\n🔏 POST /register - Received authentication request");
  console.log("📧 Address:", address);
  console.log("✍️  Signature:", signature);
  console.log("⏰ Timestamp:", timestamp);

  if (!signature || !address || !timestamp) {
    console.log("❌ Missing signature, address, or timestamp");
    return res.status(400).json({
      error: "Signature, address, and timestamp are required",
    });
  }

  // Check if address is a valid player
  console.log("🔍 Checking if address is valid player...");
  console.log("👥 Registered players:", players);

  if (!isValidPlayer(address)) {
    console.log("❌ Address not found in player list");
    return res.status(403).json({
      error: "Address is not registered as a player",
    });
  }

  console.log("✅ Address is a valid player");

  try {
    // Generate the same message that should have been signed using the provided timestamp
    const message = generateSignMessage(parseInt(timestamp));

    console.log("📝 Generated message for verification:", message);
    console.log("🔍 Verifying signature...");
    console.log("   - Address:", address);
    console.log("   - Message length:", message.length);
    console.log("   - Signature length:", signature.length);

    // Verify the signature
    const isValid = await verifyMessage({
      address: address,
      message: message,
      signature: signature,
    });

    console.log("🔒 Signature verification result:", isValid);

    if (!isValid) {
      console.log("❌ Signature verification failed");
      return res.status(401).json({
        error: "Invalid signature",
      });
    }

    console.log("✅ Signature verified successfully");

    // Generate JWT token
    const tokenPayload = {
      address: address.toLowerCase(),
      timestamp: Date.now(),
    };

    console.log("🎫 Generating JWT token with payload:", tokenPayload);

    const token = jwt.sign(tokenPayload, getJWTSecret(), {
      expiresIn: JWT_EXPIRES_IN,
    });

    console.log("✅ JWT token generated successfully");
    console.log("🎫 Token (first 20 chars):", token.substring(0, 20) + "...");

    res.json({
      success: true,
      token: token,
      expiresIn: JWT_EXPIRES_IN,
      message: "Authentication successful",
    });
  } catch (error) {
    console.error("❌ Signature verification error:", error);
    console.error("   Error details:", error.message);
    console.error("   Error stack:", error.stack);
    res.status(500).json({
      error: "Failed to verify signature",
    });
  }
});

// GET /map - Get 3x3 local map view for authenticated player
app.get("/map", authenticateToken, (req, res) => {
  const playerAddress = req.playerAddress;

  console.log("🗺️  GET /map - Getting map view for player:", playerAddress);

  const localView = getLocalMapView(playerAddress);
  if (!localView) {
    console.log("❌ Local view not found for player:", playerAddress);
    return res.status(404).json({ error: "Player not found" });
  }

  console.log("✅ Map view generated successfully");
  console.log("   - Position:", localView.position);
  console.log("   - Map size:", localView.mapSize);

  const stats = playerStats.get(playerAddress.toLowerCase());

  res.json({
    success: true,
    player: playerAddress,
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
      X: "Starting Position",
    },
  });
});

// POST /move - Move authenticated player in specified direction
app.post("/move", authenticateToken, (req, res) => {
  const playerAddress = req.playerAddress;
  const { direction } = req.body;

  console.log(
    `🏃 POST /move - Player ${playerAddress} wants to move ${direction}`
  );

  if (!direction) {
    console.log("❌ No direction provided");
    return res.status(400).json({ error: "Direction required" });
  }

  const moveResult = movePlayer(playerAddress, direction);

  if (!moveResult.success) {
    console.log("❌ Move failed:", moveResult.error);
    return res.status(400).json({ error: moveResult.error });
  }

  console.log("✅ Move successful");
  console.log("   - New position:", moveResult.newPosition);
  console.log("   - New tile:", moveResult.tile);

  // Return updated local view after move
  const localView = getLocalMapView(playerAddress);

  res.json({
    success: true,
    player: playerAddress,
    direction: direction,
    newPosition: moveResult.newPosition,
    tile: moveResult.tile,
    localView: localView.view,
    score: moveResult.score,
    movesRemaining: moveResult.movesRemaining,
    minesRemaining: moveResult.minesRemaining,
    validDirections: Object.keys(DIRECTIONS),
  });
});

// POST /mine - Mine at current position for points
app.post("/mine", authenticateToken, (req, res) => {
  const playerAddress = req.playerAddress;

  console.log(`⛏️ POST /mine - Player ${playerAddress} wants to mine`);

  const mineResult = minePlayer(playerAddress);

  if (!mineResult.success) {
    console.log("❌ Mine failed:", mineResult.error);
    return res.status(400).json({ error: mineResult.error });
  }

  console.log("✅ Mine successful");
  console.log("   - Position:", mineResult.position);
  console.log("   - Tile:", mineResult.tile);
  console.log("   - Points earned:", mineResult.pointsEarned);
  console.log("   - Total score:", mineResult.totalScore);

  // Return updated local view after mining
  const localView = getLocalMapView(playerAddress);

  res.json({
    success: true,
    player: playerAddress,
    position: mineResult.position,
    tile: mineResult.tile,
    pointsEarned: mineResult.pointsEarned,
    totalScore: mineResult.totalScore,
    movesRemaining: mineResult.movesRemaining,
    minesRemaining: mineResult.minesRemaining,
    localView: localView.view,
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

// GET /players - Get all player positions and stats
app.get("/players", (req, res) => {
  const playerData = [];

  players.forEach((address) => {
    const position = playerPositions.get(address.toLowerCase());
    const stats = playerStats.get(address.toLowerCase());
    if (position && stats) {
      playerData.push({
        address: address,
        position: position,
        tile: gameMap.land[position.y][position.x],
        score: stats.score,
        movesRemaining: stats.movesRemaining,
        minesRemaining: stats.minesRemaining,
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

  // Check for SSL credentials and configure server accordingly
  const hasSSL = checkSSLCredentials();
  const PORT = 8000; // Always use port 8000
  const PROTOCOL = hasSSL ? 'https' : 'http';

  const serverCallback = () => {
    console.log(`\n🚀 Game API Server running on ${PROTOCOL}://localhost:${PORT}`);
    console.log(`🔒 SSL: ${hasSSL ? 'ENABLED (server.key & server.cert found)' : 'DISABLED (no SSL credentials found)'}`);
    console.log(`📊 Map size: ${gameMap.size}x${gameMap.size}`);
    console.log(`👥 Players loaded: ${players.length}`);
    console.log(`🔑 Reveal seed: ${revealSeed.substring(0, 10)}...`);
    console.log(`🏠 Contract address: ${process.env.CONTRACT_ADDRESS}`);
    console.log(
      `🔐 JWT secret configured: ${
        process.env.JWT_SECRET ? "YES" : "NO"
      } (contract-specific)`
    );
    console.log(`\n🎮 Game Rules:`);
    console.log(`   - Max moves per player: ${MAX_MOVES}`);
    console.log(`   - Max mines per player: ${MAX_MINES}`);
    console.log(`   - Scoring: Common=1pt, Uncommon=5pts, Rare=10pts`);
    console.log("\n📡 API Endpoints:");
    console.log("Authentication:");
    console.log(
      `GET  ${PROTOCOL}://localhost:${PORT}/register         - Get message to sign`
    );
    console.log(
      `POST ${PROTOCOL}://localhost:${PORT}/register         - Submit signature for JWT`
    );
    console.log("\nProtected (require JWT token):");
    console.log(
      `GET  ${PROTOCOL}://localhost:${PORT}/map              - Get 3x3 local view + stats`
    );
    console.log(`POST ${PROTOCOL}://localhost:${PORT}/move             - Move player`);
    console.log(
      `POST ${PROTOCOL}://localhost:${PORT}/mine             - Mine for points`
    );
    console.log("\nPublic:");
    console.log(`GET  ${PROTOCOL}://localhost:${PORT}/status           - Game status`);
    console.log(
      `GET  ${PROTOCOL}://localhost:${PORT}/players          - All player positions + stats`
    );
    console.log("\n✅ Server ready!");
  };

  if (hasSSL) {
    // Create HTTPS server
    try {
      const httpsOptions = {
        key: fs.readFileSync("server.key"),
        cert: fs.readFileSync("server.cert"),
      };
      
      https.createServer(httpsOptions, app).listen(PORT, '0.0.0.0', serverCallback);
    } catch (error) {
      console.error("❌ Failed to start HTTPS server:", error.message);
      console.log("🔄 Falling back to HTTP server...");
             app.listen(8000, '0.0.0.0', () => {
         console.log(`\n🚀 Game API Server running on http://localhost:8000 (SSL fallback)`);
         console.log(`🔒 SSL: FAILED (could not read SSL credentials)`);
         serverCallback();
       });
    }
  } else {
    // Create HTTP server
    app.listen(PORT, '0.0.0.0', serverCallback);
  }
}

// Start the server
initializeGame().catch((error) => {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
