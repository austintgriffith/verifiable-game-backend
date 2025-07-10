// Game phases enum
export const GamePhase = {
  CREATED: "CREATED",
  COMMITTED: "COMMITTED",
  CLOSED: "CLOSED",
  GAME_RUNNING: "GAME_RUNNING",
  GAME_FINISHED: "GAME_FINISHED",
  PAYOUT_COMPLETE: "PAYOUT_COMPLETE",
  COMPLETE: "COMPLETE",
};

// Game constants
export const MAP_MULTIPLIER = 4;
export const MAX_MOVES = 12;
export const MAX_MINES = 3;
export const SAVED_DIR = "saved";

// Timer configuration
export const GAME_TIMER_DURATION = 90; // 90 seconds

// JWT Configuration
export const BASE_JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-this-in-production";
export const JWT_EXPIRES_IN = "1h";

// Tile point values
export const TILE_POINTS = {
  0: 0, // Depleted
  1: 1, // Common
  2: 5, // Uncommon
  3: 10, // Rare
  X: 25, // Starting position (ultra rare)
};

// Movement directions
export const DIRECTIONS = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
  northeast: { x: 1, y: -1 },
  northwest: { x: -1, y: -1 },
  southeast: { x: 1, y: 1 },
  southwest: { x: -1, y: 1 },
};

// Contract ABI
export const FULL_CONTRACT_ABI = [
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
    name: "GameOpened",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "gameId", type: "uint256" },
      { indexed: false, name: "startTime", type: "uint256" },
      { indexed: false, name: "mapSize", type: "uint256" },
    ],
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
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "gameId", type: "uint256" },
      { indexed: false, name: "blockHash", type: "bytes32" },
      { indexed: false, name: "url", type: "string" },
    ],
    name: "BlockHashStored",
    type: "event",
  },
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
      { name: "_hasStoredBlockHash", type: "bool" },
      { name: "_mapSize", type: "uint256" },
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
      { name: "_url", type: "string" },
    ],
    name: "storeCommitBlockHash",
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
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getMapSize",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getGameUrl",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "gameId", type: "uint256" }],
    name: "getCommitBlockHash",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
];
