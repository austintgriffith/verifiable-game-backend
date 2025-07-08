import express from "express";
import fs from "fs";
import https from "https";
import jwt from "jsonwebtoken";
import { verifyMessage } from "viem";
import { PlayerPositionGenerator } from "deterministic-map";
import {
  BASE_JWT_SECRET,
  JWT_EXPIRES_IN,
  MAX_MOVES,
  MAX_MINES,
  TILE_POINTS,
  DIRECTIONS,
  MAP_MULTIPLIER,
  GAME_TIMER_DURATION,
  FULL_CONTRACT_ABI,
} from "./constants.js";
import { log, safeJsonConvert } from "./utils.js";
import {
  loadGameMap,
  loadRevealValue,
  calculateRandomHash,
  saveGameScores,
} from "./fileService.js";

// Express app instance
const app = express();

// Game server state
let gameMap = null;
let players = [];
let playerPositions = new Map();
let playerStats = new Map();
let revealSeed = null;

// Timer state
let gameStartTime = null;
let gameTimerInterval = null;

// Global references (will be injected)
let globalPublicClient = null;
let globalContractAddress = null;
let currentGameId = null;

// Initialize global references
export function initGameServerGlobals(publicClient, contractAddress, gameId) {
  globalPublicClient = publicClient;
  globalContractAddress = contractAddress;
  currentGameId = gameId;
}

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
  if (gameMap && gameMap.size) {
    return gameMap.size;
  }

  const playerCount = players.length;
  return playerCount > 0 ? 1 + MAP_MULTIPLIER * playerCount : 5;
}

function wrapCoordinate(coord, mapSize = null) {
  const size = mapSize || getCurrentMapSize();
  const result = ((coord % size) + size) % size;
  return result;
}

export function getCurrentPlayerData(gameId) {
  const playerData = [];
  players.forEach((address) => {
    const position = playerPositions.get(address.toLowerCase());
    const stats = playerStats.get(address.toLowerCase());
    if (position && stats) {
      const wrappedX = wrapCoordinate(position.x, gameMap?.size);
      const wrappedY = wrapCoordinate(position.y, gameMap?.size);

      let tile = 0;
      if (
        gameMap &&
        gameMap.land &&
        gameMap.land[wrappedY] &&
        gameMap.land[wrappedY][wrappedX] !== undefined
      ) {
        tile = gameMap.land[wrappedY][wrappedX];
      }

      playerData.push({
        address,
        position: { x: wrappedX, y: wrappedY },
        tile,
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

export function getTimeRemaining() {
  if (!gameStartTime) return 0;
  const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
  return Math.max(0, GAME_TIMER_DURATION - elapsed);
}

export function forceFinishGameOnTimer(gameId) {
  log(`⏰ Timer expired! Force finishing game ${gameId}...`, gameId);

  const playerData = getCurrentPlayerData(gameId);
  log(`📊 Game ending due to timer - Current player stats:`, gameId);
  playerData.forEach((player, index) => {
    log(`  Player ${index + 1}: ${player.address}`, gameId);
    log(
      `    Score: ${player.score}, Moves: ${player.movesRemaining}, Mines: ${player.minesRemaining}`,
      gameId
    );
  });

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

  if (gameTimerInterval) {
    clearTimeout(gameTimerInterval);
    gameTimerInterval = null;
  }
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

    const mapSize = getCurrentMapSize();
    const playerPositionGenerator = new PlayerPositionGenerator(revealSeed);

    contractPlayers.forEach((playerAddress) => {
      const startPos = playerPositionGenerator.generateStartingPosition(
        playerAddress,
        gameId,
        mapSize
      );

      const wrappedPos = {
        x: wrapCoordinate(startPos.x, mapSize),
        y: wrapCoordinate(startPos.y, mapSize),
      };

      playerPositions.set(playerAddress.toLowerCase(), wrappedPos);
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
      return res.status(403).json({ error: "Player no longer registered" });
    }

    req.playerAddress = decoded.address;
    next();
  });
}

// Game logic functions
function getLocalMapView(playerAddress) {
  const position = playerPositions.get(playerAddress.toLowerCase());
  if (!position) {
    return null;
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

  return { view: localView, position };
}

function movePlayer(playerAddress, direction) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    return { success: false, error: "Player not found" };
  }

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    return { success: false, error: "Player stats not found" };
  }

  if (stats.movesRemaining <= 0)
    return { success: false, error: "No moves remaining" };

  if (typeof direction !== "string") {
    return { success: false, error: "Direction must be a string" };
  }

  const normalizedDirection = direction.toLowerCase().trim();
  const dirVector = DIRECTIONS[normalizedDirection];
  if (!dirVector) {
    return { success: false, error: "Invalid direction" };
  }

  const newX = wrapCoordinate(currentPos.x + dirVector.x, gameMap.size);
  const newY = wrapCoordinate(currentPos.y + dirVector.y, gameMap.size);

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

  return result;
}

function minePlayer(playerAddress) {
  const currentPos = playerPositions.get(playerAddress.toLowerCase());
  if (!currentPos) {
    return { success: false, error: "Player not found" };
  }

  const stats = playerStats.get(playerAddress.toLowerCase());
  if (!stats) {
    return { success: false, error: "Player stats not found" };
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
    serverStatus: "running",
    playerCount: players.length,
    timestamp: new Date().toISOString(),
    timer: {
      active: gameActive,
      duration: GAME_TIMER_DURATION,
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
  const timeRemaining = getTimeRemaining();

  const response = {
    success: true,
    player: req.playerAddress,
    localView: localView.view,
    position: localView.position,
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

  res.json(response);
});

app.post("/move", authenticateToken, (req, res) => {
  const { direction } = req.body;

  if (!direction) {
    return res.status(400).json({ error: "Direction required" });
  }

  const timeRemaining = getTimeRemaining();
  if (timeRemaining <= 0) {
    return res.status(400).json({ error: "Time expired! Game over." });
  }

  const moveResult = movePlayer(req.playerAddress, direction);
  if (!moveResult.success) {
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

  res.json(response);
});

app.post("/mine", authenticateToken, (req, res) => {
  const timeRemaining = getTimeRemaining();
  if (timeRemaining <= 0) {
    return res.status(400).json({ error: "Time expired! Game over." });
  }

  const mineResult = minePlayer(req.playerAddress);
  if (!mineResult.success) {
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

  res.json(response);
});

app.get("/status", (req, res) => {
  const timeRemaining = getTimeRemaining();
  const gameActive = gameStartTime !== null;

  res.json({
    success: true,
    gameId: currentGameId,
    gameLoaded: gameMap !== null,
    totalPlayers: players.length,
    players,
    serverTime: new Date().toISOString(),
    timer: {
      active: gameActive,
      duration: GAME_TIMER_DURATION,
      timeRemaining: timeRemaining,
      timeElapsed: gameActive ? GAME_TIMER_DURATION - timeRemaining : 0,
      startTime: gameStartTime,
    },
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
  });
});

// Game server initialization
export async function initializeGameServer(
  gameId,
  globalPublicClient,
  globalContractAddress
) {
  try {
    log(`🔧 Initializing game server for game ${gameId}...`, gameId);

    // Initialize global references
    initGameServerGlobals(globalPublicClient, globalContractAddress, gameId);

    log(`📂 Loading game map...`, gameId);
    gameMap = loadGameMap(gameId);
    log(`✅ Game map loaded: ${gameMap.size}x${gameMap.size}`, gameId);

    log(`🔑 Loading reveal value and calculating random hash...`, gameId);
    const revealValue = loadRevealValue(gameId);
    revealSeed = await calculateRandomHash(
      gameId,
      revealValue,
      globalPublicClient,
      globalContractAddress,
      FULL_CONTRACT_ABI
    );
    log(`✅ Random hash calculated: ${revealSeed.substring(0, 10)}...`, gameId);

    log(`👥 Loading players from contract...`, gameId);
    const playersLoaded = await loadPlayersFromContract(gameId);
    if (!playersLoaded) {
      log(`❌ Failed to load players from contract`, gameId);
      return false;
    }
    log(`✅ Loaded ${players.length} players`, gameId);

    gameStartTime = Date.now();
    log(
      `⏰ Game timer started - players have ${GAME_TIMER_DURATION} seconds`,
      gameId
    );

    gameTimerInterval = setTimeout(() => {
      log(`⏰ Timer expired! Auto-finishing game ${gameId}`, gameId);
      forceFinishGameOnTimer(gameId);
    }, GAME_TIMER_DURATION * 1000);

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
          const httpsServer = https.createServer(httpsOptions, app);
          httpsServer.listen(PORT, "0.0.0.0", () => {
            log(`🚀 HTTPS Game Server running on port ${PORT}`, gameId);
            log(`🌍 Access at: https://localhost:${PORT}`, gameId);
            resolve({ server: httpsServer, isHTTPS: true });
          });
          httpsServer.on("error", (error) => {
            log(`❌ HTTPS server error: ${error.message}`, gameId);
            resolve({ server: null, isHTTPS: false });
          });
        } catch (error) {
          log(
            `❌ SSL setup failed, falling back to HTTP: ${error.message}`,
            gameId
          );
          const httpServer = app.listen(PORT, "0.0.0.0", () => {
            log(`🚀 HTTP Game Server running on port ${PORT}`, gameId);
            log(`🌍 Access at: http://localhost:${PORT}`, gameId);
            resolve({ server: httpServer, isHTTPS: false });
          });
          httpServer.on("error", (error) => {
            log(`❌ HTTP server error: ${error.message}`, gameId);
            resolve({ server: null, isHTTPS: false });
          });
        }
      } else {
        log(`🌐 Setting up HTTP server...`, gameId);
        const httpServer = app.listen(PORT, "0.0.0.0", () => {
          log(`🚀 HTTP Game Server running on port ${PORT}`, gameId);
          log(`🌍 Access at: http://localhost:${PORT}`, gameId);
          resolve({ server: httpServer, isHTTPS: false });
        });
        httpServer.on("error", (error) => {
          log(`❌ HTTP server error: ${error.message}`, gameId);
          resolve({ server: null, isHTTPS: false });
        });
      }
    });
  } catch (error) {
    log(`❌ Error initializing game server: ${error.message}`, gameId);
    log(`📍 Stack trace: ${error.stack}`, gameId);
    return { server: null, isHTTPS: false };
  }
}

// Clean up game server state
export function cleanupGameServer() {
  gameMap = null;
  players = [];
  playerPositions.clear();
  playerStats.clear();
  revealSeed = null;
  gameStartTime = null;

  if (gameTimerInterval) {
    clearTimeout(gameTimerInterval);
    gameTimerInterval = null;
  }
}
