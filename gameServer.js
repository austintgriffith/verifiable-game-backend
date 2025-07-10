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

// Global registry of active game server instances
const activeGameServers = new Map(); // gameId -> GameServerInstance

// GameServerInstance class to encapsulate each game's state and methods
class GameServerInstance {
  constructor(gameId, globalPublicClient, globalContractAddress) {
    this.gameId = gameId;
    this.globalPublicClient = globalPublicClient;
    this.globalContractAddress = globalContractAddress;
    this.port = 8000 + parseInt(gameId);

    // Express app instance for this game
    this.app = express();

    // Game server state
    this.gameMap = null;
    this.players = [];
    this.playerPositions = new Map();
    this.playerStats = new Map();
    this.revealSeed = null;

    // Timer state
    this.gameStartTime = null;
    this.gameTimerInterval = null;

    // Server instances
    this.httpServer = null;
    this.httpsServer = null;

    // Initialize middleware and routes
    this.initializeMiddleware();
    this.initializeRoutes();
  }

  getJWTSecret() {
    if (!this.globalContractAddress) {
      throw new Error("Contract address not initialized");
    }
    return BASE_JWT_SECRET + "-" + this.globalContractAddress.toLowerCase();
  }

  generateSignMessage(providedTimestamp = null) {
    const timestamp = providedTimestamp || Date.now();
    return `Sign this message to authenticate with the game server.\n\nContract: ${this.globalContractAddress}\nGameId: ${this.gameId}\nNamespace: ScriptGame\nTimestamp: ${timestamp}\n\nThis signature is valid for 5 minutes.`;
  }

  isValidPlayer(address) {
    return this.players.some(
      (player) => player.toLowerCase() === address.toLowerCase()
    );
  }

  getCurrentMapSize() {
    if (this.gameMap && this.gameMap.size) {
      return this.gameMap.size;
    }
    const playerCount = this.players.length;
    return playerCount > 0 ? 1 + MAP_MULTIPLIER * playerCount : 5;
  }

  wrapCoordinate(coord, mapSize = null) {
    const size = mapSize || this.getCurrentMapSize();
    const result = ((coord % size) + size) % size;
    return result;
  }

  getCurrentPlayerData() {
    const playerData = [];
    this.players.forEach((address) => {
      const position = this.playerPositions.get(address.toLowerCase());
      const stats = this.playerStats.get(address.toLowerCase());
      if (position && stats) {
        const wrappedX = this.wrapCoordinate(position.x, this.gameMap?.size);
        const wrappedY = this.wrapCoordinate(position.y, this.gameMap?.size);

        let tile = 0;
        if (
          this.gameMap &&
          this.gameMap.land &&
          this.gameMap.land[wrappedY] &&
          this.gameMap.land[wrappedY][wrappedX] !== undefined
        ) {
          tile = this.gameMap.land[wrappedY][wrappedX];
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

  getSanitizedPlayerData() {
    const playerData = [];
    this.players.forEach((address) => {
      const stats = this.playerStats.get(address.toLowerCase());
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

  getTimeRemaining() {
    if (!this.gameStartTime) return 0;
    const elapsed = Math.floor((Date.now() - this.gameStartTime) / 1000);
    return Math.max(0, GAME_TIMER_DURATION - elapsed);
  }

  forceFinishGameOnTimer() {
    log(
      `⏰ Timer expired! Force finishing game ${this.gameId}...`,
      this.gameId
    );

    const playerData = this.getCurrentPlayerData();
    log(`📊 Game ending due to timer - Current player stats:`, this.gameId);
    playerData.forEach((player, index) => {
      log(`  Player ${index + 1}: ${player.address}`, this.gameId);
      log(
        `    Score: ${player.score}, Moves: ${player.movesRemaining}, Mines: ${player.minesRemaining}`,
        this.gameId
      );
    });

    this.players.forEach((address) => {
      const stats = this.playerStats.get(address.toLowerCase());
      if (stats) {
        stats.movesRemaining = 0;
        stats.minesRemaining = 0;
        this.playerStats.set(address.toLowerCase(), stats);
      }
    });

    log(
      `🏁 All players' moves and mines set to 0 due to timer expiration`,
      this.gameId
    );

    if (this.gameTimerInterval) {
      clearTimeout(this.gameTimerInterval);
      this.gameTimerInterval = null;
    }
  }

  async loadPlayersFromContract() {
    try {
      const contractPlayers = await this.globalPublicClient.readContract({
        address: this.globalContractAddress,
        abi: FULL_CONTRACT_ABI,
        functionName: "getPlayers",
        args: [BigInt(this.gameId)],
      });

      this.players = contractPlayers;
      this.playerPositions.clear();
      this.playerStats.clear();

      const mapSize = this.getCurrentMapSize();
      const playerPositionGenerator = new PlayerPositionGenerator(
        this.revealSeed
      );

      contractPlayers.forEach((playerAddress) => {
        const startPos = playerPositionGenerator.generateStartingPosition(
          playerAddress,
          this.gameId,
          mapSize
        );

        const wrappedPos = {
          x: this.wrapCoordinate(startPos.x, mapSize),
          y: this.wrapCoordinate(startPos.y, mapSize),
        };

        this.playerPositions.set(playerAddress.toLowerCase(), wrappedPos);
        this.playerStats.set(playerAddress.toLowerCase(), {
          score: 0,
          movesRemaining: MAX_MOVES,
          minesRemaining: MAX_MINES,
        });
      });

      log(
        `Loaded ${contractPlayers.length} players from contract`,
        this.gameId
      );
      return true;
    } catch (error) {
      log(`Error loading players: ${error.message}`, this.gameId);
      return false;
    }
  }

  initializeMiddleware() {
    this.app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
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

    this.app.use(express.json());

    this.app.set("json replacer", function (key, value) {
      if (typeof value === "bigint") {
        return Number(value);
      }
      return value;
    });
  }

  authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    jwt.verify(token, this.getJWTSecret(), (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: "Invalid or expired token" });
      }

      if (!this.isValidPlayer(decoded.address)) {
        return res.status(403).json({ error: "Player no longer registered" });
      }

      req.playerAddress = decoded.address;
      next();
    });
  };

  getLocalMapView(playerAddress) {
    const position = this.playerPositions.get(playerAddress.toLowerCase());
    if (!position) {
      return null;
    }

    const localView = [];
    const { x: centerX, y: centerY } = position;

    for (let dy = -1; dy <= 1; dy++) {
      const row = [];
      for (let dx = -1; dx <= 1; dx++) {
        const mapX = this.wrapCoordinate(centerX + dx, this.gameMap.size);
        const mapY = this.wrapCoordinate(centerY + dy, this.gameMap.size);
        const tile = this.gameMap.land[mapY][mapX];

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

  movePlayer(playerAddress, direction) {
    const currentPos = this.playerPositions.get(playerAddress.toLowerCase());
    if (!currentPos) {
      return { success: false, error: "Player not found" };
    }

    const stats = this.playerStats.get(playerAddress.toLowerCase());
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

    const newX = this.wrapCoordinate(
      currentPos.x + dirVector.x,
      this.gameMap.size
    );
    const newY = this.wrapCoordinate(
      currentPos.y + dirVector.y,
      this.gameMap.size
    );

    this.playerPositions.set(playerAddress.toLowerCase(), { x: newX, y: newY });
    stats.movesRemaining--;
    this.playerStats.set(playerAddress.toLowerCase(), stats);

    const result = {
      success: true,
      newPosition: { x: newX, y: newY },
      tile: this.gameMap.land[newY][newX],
      movesRemaining: stats.movesRemaining,
      minesRemaining: stats.minesRemaining,
      score: stats.score,
    };

    return result;
  }

  minePlayer(playerAddress) {
    const currentPos = this.playerPositions.get(playerAddress.toLowerCase());
    if (!currentPos) {
      return { success: false, error: "Player not found" };
    }

    const stats = this.playerStats.get(playerAddress.toLowerCase());
    if (!stats) {
      return { success: false, error: "Player stats not found" };
    }

    if (stats.minesRemaining <= 0)
      return { success: false, error: "No mines remaining" };

    const currentTile = this.gameMap.land[currentPos.y][currentPos.x];
    if (currentTile === 0)
      return { success: false, error: "Tile already mined" };

    const pointsEarned = TILE_POINTS[currentTile] || 0;
    stats.score += pointsEarned;
    stats.minesRemaining--;
    this.playerStats.set(playerAddress.toLowerCase(), stats);

    this.gameMap.land[currentPos.y][currentPos.x] = 0;

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

  initializeRoutes() {
    // API Routes
    this.app.get("/", (req, res) => {
      const timeRemaining = this.getTimeRemaining();
      const gameActive = this.gameStartTime !== null;

      res.json({
        success: true,
        message: "Automated Game Server",
        version: "2.0.0",
        gameId: this.gameId,
        port: this.port,
        serverStatus: "running",
        playerCount: this.players.length,
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

    this.app.get("/test", (req, res) => {
      res.json({
        success: true,
        message: "Server is running!",
        gameId: this.gameId,
        port: this.port,
        timestamp: new Date().toISOString(),
        gameLoaded: this.gameMap !== null,
        playersCount: this.players.length,
      });
    });

    this.app.get("/register", (req, res) => {
      const timestamp = Date.now();
      const message = this.generateSignMessage(timestamp);

      res.json({
        success: true,
        message,
        timestamp,
        gameId: this.gameId,
        instructions:
          "Sign this message with your Ethereum wallet to authenticate",
      });
    });

    this.app.post("/register", async (req, res) => {
      const { signature, address, timestamp } = req.body;

      if (!signature || !address || !timestamp) {
        return res.status(400).json({
          error: "Signature, address, and timestamp are required",
        });
      }

      if (!this.isValidPlayer(address)) {
        return res.status(403).json({
          error: "Address is not registered as a player",
        });
      }

      try {
        const message = this.generateSignMessage(parseInt(timestamp));
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

        const token = jwt.sign(tokenPayload, this.getJWTSecret(), {
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

    this.app.get("/map", this.authenticateToken, (req, res) => {
      const localView = this.getLocalMapView(req.playerAddress);
      if (!localView) {
        return res.status(404).json({ error: "Player not found" });
      }

      const stats = this.playerStats.get(req.playerAddress.toLowerCase());
      const timeRemaining = this.getTimeRemaining();

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

    this.app.post("/move", this.authenticateToken, (req, res) => {
      const { direction } = req.body;

      if (!direction) {
        return res.status(400).json({ error: "Direction required" });
      }

      const timeRemaining = this.getTimeRemaining();
      if (timeRemaining <= 0) {
        return res.status(400).json({ error: "Time expired! Game over." });
      }

      const moveResult = this.movePlayer(req.playerAddress, direction);
      if (!moveResult.success) {
        return res.status(400).json({ error: moveResult.error });
      }

      const localView = this.getLocalMapView(req.playerAddress);

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

    this.app.post("/mine", this.authenticateToken, (req, res) => {
      const timeRemaining = this.getTimeRemaining();
      if (timeRemaining <= 0) {
        return res.status(400).json({ error: "Time expired! Game over." });
      }

      const mineResult = this.minePlayer(req.playerAddress);
      if (!mineResult.success) {
        return res.status(400).json({ error: mineResult.error });
      }

      const localView = this.getLocalMapView(req.playerAddress);

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

    this.app.get("/status", (req, res) => {
      const timeRemaining = this.getTimeRemaining();
      const gameActive = this.gameStartTime !== null;

      res.json({
        success: true,
        gameId: this.gameId,
        port: this.port,
        gameLoaded: this.gameMap !== null,
        totalPlayers: this.players.length,
        players: this.players,
        serverTime: new Date().toISOString(),
        timer: {
          active: gameActive,
          duration: GAME_TIMER_DURATION,
          timeRemaining: timeRemaining,
          timeElapsed: gameActive ? GAME_TIMER_DURATION - timeRemaining : 0,
          startTime: this.gameStartTime,
        },
      });
    });

    this.app.get("/players", (req, res) => {
      const playerData = this.getSanitizedPlayerData();
      const timeRemaining = this.getTimeRemaining();

      res.json({
        success: true,
        gameId: this.gameId,
        players: playerData,
        count: playerData.length,
        timeRemaining: timeRemaining,
      });
    });
  }

  async startServer() {
    try {
      log(`📂 Loading game map...`, this.gameId);
      this.gameMap = loadGameMap(this.gameId);
      log(
        `✅ Game map loaded: ${this.gameMap.size}x${this.gameMap.size}`,
        this.gameId
      );

      log(
        `🔑 Loading reveal value and calculating random hash...`,
        this.gameId
      );
      const revealValue = loadRevealValue(this.gameId);
      this.revealSeed = await calculateRandomHash(
        this.gameId,
        revealValue,
        this.globalPublicClient,
        this.globalContractAddress,
        FULL_CONTRACT_ABI
      );
      log(
        `✅ Random hash calculated: ${this.revealSeed.substring(0, 10)}...`,
        this.gameId
      );

      log(`👥 Loading players from contract...`, this.gameId);
      const playersLoaded = await this.loadPlayersFromContract();
      if (!playersLoaded) {
        log(`❌ Failed to load players from contract`, this.gameId);
        return { server: null, isHTTPS: false };
      }
      log(`✅ Loaded ${this.players.length} players`, this.gameId);

      this.gameStartTime = Date.now();
      log(
        `⏰ Game timer started - players have ${GAME_TIMER_DURATION} seconds`,
        this.gameId
      );

      this.gameTimerInterval = setTimeout(() => {
        log(
          `⏰ Timer expired! Auto-finishing game ${this.gameId}`,
          this.gameId
        );
        this.forceFinishGameOnTimer();
      }, GAME_TIMER_DURATION * 1000);

      const hasSSL =
        fs.existsSync("server.key") && fs.existsSync("server.cert");
      log(`🔒 SSL available: ${hasSSL}`, this.gameId);

      return new Promise((resolve) => {
        if (hasSSL) {
          try {
            log(
              `🔐 Setting up HTTPS server on port ${this.port}...`,
              this.gameId
            );
            const httpsOptions = {
              key: fs.readFileSync("server.key"),
              cert: fs.readFileSync("server.cert"),
            };
            this.httpsServer = https.createServer(httpsOptions, this.app);
            this.httpsServer.listen(this.port, "0.0.0.0", () => {
              log(
                `🚀 HTTPS Game Server running on port ${this.port}`,
                this.gameId
              );
              log(`🌍 Access at: https://localhost:${this.port}`, this.gameId);
              resolve({ server: this.httpsServer, isHTTPS: true });
            });
            this.httpsServer.on("error", (error) => {
              log(`❌ HTTPS server error: ${error.message}`, this.gameId);
              resolve({ server: null, isHTTPS: false });
            });
          } catch (error) {
            log(
              `❌ SSL setup failed, falling back to HTTP: ${error.message}`,
              this.gameId
            );
            this.httpServer = this.app.listen(this.port, "0.0.0.0", () => {
              log(
                `🚀 HTTP Game Server running on port ${this.port}`,
                this.gameId
              );
              log(`🌍 Access at: http://localhost:${this.port}`, this.gameId);
              resolve({ server: this.httpServer, isHTTPS: false });
            });
            this.httpServer.on("error", (error) => {
              log(`❌ HTTP server error: ${error.message}`, this.gameId);
              resolve({ server: null, isHTTPS: false });
            });
          }
        } else {
          log(`🌐 Setting up HTTP server on port ${this.port}...`, this.gameId);
          this.httpServer = this.app.listen(this.port, "0.0.0.0", () => {
            log(
              `🚀 HTTP Game Server running on port ${this.port}`,
              this.gameId
            );
            log(`🌍 Access at: http://localhost:${this.port}`, this.gameId);
            resolve({ server: this.httpServer, isHTTPS: false });
          });
          this.httpServer.on("error", (error) => {
            log(`❌ HTTP server error: ${error.message}`, this.gameId);
            resolve({ server: null, isHTTPS: false });
          });
        }
      });
    } catch (error) {
      log(`❌ Error starting game server: ${error.message}`, this.gameId);
      log(`📍 Stack trace: ${error.stack}`, this.gameId);
      return { server: null, isHTTPS: false };
    }
  }

  cleanup() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.httpsServer) {
      this.httpsServer.close();
      this.httpsServer = null;
    }

    this.gameMap = null;
    this.players = [];
    this.playerPositions.clear();
    this.playerStats.clear();
    this.revealSeed = null;
    this.gameStartTime = null;

    if (this.gameTimerInterval) {
      clearTimeout(this.gameTimerInterval);
      this.gameTimerInterval = null;
    }

    log(`Game server cleanup completed for game ${this.gameId}`, this.gameId);
  }
}

// Public API functions for managing multiple game servers
export async function initializeGameServer(
  gameId,
  globalPublicClient,
  globalContractAddress
) {
  try {
    log(
      `🔧 Initializing game server for game ${gameId} on port ${
        8000 + parseInt(gameId)
      }...`,
      gameId
    );

    // Create new game server instance
    const gameServerInstance = new GameServerInstance(
      gameId,
      globalPublicClient,
      globalContractAddress
    );

    // Start the server
    const serverResult = await gameServerInstance.startServer();

    if (serverResult.server) {
      // Register the instance in our global registry
      activeGameServers.set(gameId, gameServerInstance);
      log(`✅ Game server started successfully for game ${gameId}!`, gameId);
      return serverResult;
    } else {
      log(`❌ Failed to start game server for game ${gameId}`, gameId);
      return { server: null, isHTTPS: false };
    }
  } catch (error) {
    log(`❌ Error initializing game server: ${error.message}`, gameId);
    return { server: null, isHTTPS: false };
  }
}

export function cleanupGameServer(gameId) {
  const gameServerInstance = activeGameServers.get(gameId);
  if (gameServerInstance) {
    gameServerInstance.cleanup();
    activeGameServers.delete(gameId);
  }
}

export function getCurrentPlayerData(gameId) {
  const gameServerInstance = activeGameServers.get(gameId);
  if (gameServerInstance) {
    return gameServerInstance.getCurrentPlayerData();
  }
  return [];
}

export function getTimeRemaining(gameId) {
  const gameServerInstance = activeGameServers.get(gameId);
  if (gameServerInstance) {
    return gameServerInstance.getTimeRemaining();
  }
  return 0;
}

export function forceFinishGameOnTimer(gameId) {
  const gameServerInstance = activeGameServers.get(gameId);
  if (gameServerInstance) {
    gameServerInstance.forceFinishGameOnTimer();
  }
}

export function getActiveGameServers() {
  return Array.from(activeGameServers.keys());
}

export function getGameServerInfo(gameId) {
  const gameServerInstance = activeGameServers.get(gameId);
  if (gameServerInstance) {
    return {
      gameId: gameServerInstance.gameId,
      port: gameServerInstance.port,
      playerCount: gameServerInstance.players.length,
      gameLoaded: gameServerInstance.gameMap !== null,
      gameStartTime: gameServerInstance.gameStartTime,
      timeRemaining: gameServerInstance.getTimeRemaining(),
    };
  }
  return null;
}

// Generate URL for a specific game server
export function generateGameServerUrl(gameId, isHTTPS = false) {
  const port = 8000 + parseInt(gameId);
  const baseUrl = process.env.GAME_API_BASE || "http://localhost";

  // If we have GAME_API_BASE set and it includes protocol, use it as-is
  // Otherwise, use the isHTTPS parameter to determine protocol
  if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) {
    return `${baseUrl}:${port}`;
  } else {
    const protocol = isHTTPS ? "https" : "http";
    return `${protocol}://${baseUrl}:${port}`;
  }
}
