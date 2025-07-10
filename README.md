# Verifiable Backend 

## [https://cryptohunter.fun](https://cryptohunter.fun/)

## 🎮 Core Features

### **Automated Game Manager**

- **Blockchain Game Server**: Manages commit-reveal based games with automatic state transitions
- **Deterministic Map Generation**: Creates fair, reproducible game maps using on-chain randomness
- **Real-time Game API**: HTTP server providing game interaction endpoints
- **Player Management**: JWT authentication with Ethereum signature verification
- **Score Tracking**: Automatic scoring and payout distribution

### **DeFi Utility Scripts**

- **Account Management**: Balance checking and portfolio tracking
- **Token Swapping**: Smart routing across Aerodrome and Uniswap V2
- **Multi-network Support**: Works on Base mainnet and localhost forks

## 🚀 Quick Start

### 1. Installation

```bash
yarn install
```

### 2. Environment Configuration

Create a `.env` file:

**For Base Mainnet:**

```bash
PRIVKEY=your_private_key_here
CHAIN_ID=8453
ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/your-api-key
CONTRACT_ADDRESS=your_game_contract_address
```

**For Base Fork (Localhost):**

```bash
PRIVKEY=your_private_key_here
CHAIN_ID=31337
ALCHEMY_API_KEY=http://localhost:8545
CONTRACT_ADDRESS=your_game_contract_address
```

### 3. Start the Game Manager

```bash
yarn game
```

This starts the automated game management system that:

- Scans for existing games where you're the gamemaster
- Processes game state transitions automatically
- Starts game servers when games are ready
- Handles payouts and cleanup

## 📋 Available Scripts

### 🎮 Game Management

| Script           | Command       | Description                                |
| ---------------- | ------------- | ------------------------------------------ |
| **Game Manager** | `yarn game`   | Start the automated game management system |
| **Open Game**    | `yarn open`   | Open a game for players to join            |
| **Close Game**   | `yarn close`  | Close a game and start the server          |
| **Commit Hash**  | `yarn commit` | Commit a hash for secure randomness        |
| **Reveal Hash**  | `yarn reveal` | Reveal the committed hash                  |
| **Payout**       | `yarn payout` | Manually trigger game payout               |
| **Print Info**   | `yarn print`  | Display game information                   |

### 💰 DeFi Utilities

| Script           | Command             | Description                        |
| ---------------- | ------------------- | ---------------------------------- |
| **Account Info** | `yarn account`      | Check ETH, WETH, and USDC balances |
| **Buy USDC**     | `yarn swap 100`     | Swap ETH for $100 worth of USDC    |
| **Sell USDC**    | `yarn swap-back 50` | Swap $50 worth of USDC back to ETH |

## 🎯 Game System Overview

### Game Flow

1. **Game Creation**: Gamemaster creates a new game with stake amount
2. **Player Registration**: Players join by staking ETH
3. **Game Closure**: Creator closes the game, determining final map size
4. **Commit Phase**: System commits a hash for secure randomness
5. **Game Execution**: 90-second exploration game with HTTP API
6. **Scoring & Payout**: Winners are determined and paid automatically

### Game Mechanics

- **Map Size**: `1 + (4 × player_count)` (e.g., 3 players = 13×13 map)
- **Timer**: 90 seconds per game
- **Movement**: 12 moves maximum per player
- **Mining**: 3 mines maximum per player
- **Scoring**: Different land types award different points

### Land Types & Scoring

- **Depleted (0)**: 0 points
- **Common (1)**: 1 point
- **Uncommon (2)**: 5 points
- **Rare (3)**: 10 points
- **Starting Position (X)**: 25 points

## 🌐 Game Server API

When a game is active, the system starts an HTTP server on port 8000:

### Key Endpoints

- `GET /` - Server status and game info
- `GET /register` - Get authentication message
- `POST /register` - Authenticate with signature
- `GET /map` - Get local map view (requires auth)
- `POST /move` - Move player (requires auth)
- `POST /mine` - Mine current tile (requires auth)
- `GET /status` - Current game status
- `GET /players` - Player information

### Authentication

Players must sign a message with their wallet to receive a JWT token:

1. `GET /register` to get the message
2. Sign the message with your wallet
3. `POST /register` with signature to get token
4. Use token in `Authorization: Bearer <token>` header

## 🔧 Technical Architecture

### Game State Management

The system tracks multiple game phases:

- `CREATED` → `COMMITTED` → `CLOSED` → `GAME_RUNNING` → `GAME_FINISHED` → `PAYOUT_COMPLETE`

### File Structure

```
admin-script/
├── game.js              # Main game manager
├── gameServer.js         # HTTP API server
├── gameStateManager.js   # State transition logic
├── eventListener.js      # Blockchain event monitoring
├── contractService.js    # Smart contract interactions
├── fileService.js        # File management utilities
├── clients.js           # Blockchain client setup
├── constants.js         # Game configuration
├── utils.js             # Utility functions
├── account.js           # Account management
├── [swap scripts]       # DeFi utilities
└── saved/               # Game data storage
```

### Dependencies

- **viem**: Ethereum client library
- **express**: HTTP server framework
- **jsonwebtoken**: JWT authentication
- **deterministic-map**: Deterministic map generation
- **dotenv**: Environment configuration

## 🌍 Network Support

### Base Mainnet

```bash
CHAIN_ID=8453
ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/your-api-key
```

### Base Fork (Localhost)

```bash
CHAIN_ID=31337
ALCHEMY_API_KEY=http://localhost:8545
```

**Contract Addresses** (same on both networks):

- **USDC**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **WETH**: `0x4200000000000000000000000000000000000006`
- **Aerodrome Router**: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- **Uniswap V2 Router**: `0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24`

## 🔍 Usage Examples

### Game Management

```bash
# Start the automated game manager
yarn game

# In another terminal, check account
yarn account

# Create and manage a game
yarn open    # Open for players
yarn close   # Close and start server
yarn commit  # Commit randomness
yarn reveal  # Reveal and generate map
```

### DeFi Operations

```bash
# Check balances
yarn account

# Trade operations
yarn swap 500      # Buy $500 worth of USDC
yarn swap-back 200 # Sell $200 worth back to ETH
```

## 📊 Monitoring & Logs

The game manager provides comprehensive logging:

- **Game State**: Current phase and player count
- **Server Status**: Active games and port information
- **Transaction**: Blockchain interaction results
- **Timer Warnings**: Game countdown notifications

## 🛡️ Security Features

- **Commit-Reveal Scheme**: Secure randomness generation
- **JWT Authentication**: Secure API access
- **Signature Verification**: Ethereum wallet authentication
- **Game State Validation**: Prevents invalid state transitions
- **Timer Protection**: Automatic game termination

## 📱 Frontend Integration

For frontend applications, the contract provides:

- `getMapSize(gameId)` - Get map dimensions
- `getCommitRevealState(gameId)` - Get game state
- `getPayoutInfo(gameId)` - Get winner information
- `getPlayers(gameId)` - Get player list

## 🚨 Troubleshooting

### Common Issues

1. **Connection Issues**: Verify RPC URL and network configuration
2. **Authentication**: Ensure wallet signatures are valid
3. **Game State**: Check that games are in the correct phase
4. **Timer Issues**: Games automatically end after 90 seconds
5. **File Permissions**: Ensure `saved/` directory is writable

### Debug Commands

```bash
# Check game state
yarn print

# Verify account setup
yarn account

# Test network connectivity
# (The game manager will show connection status)
```

## 📄 API Documentation

For complete API documentation, see `api-docs.txt` which includes:

- Detailed endpoint specifications
- Authentication flow
- Response formats
- Error handling
- Game mechanics

## 🤝 Contributing

This is an automated game management system designed for production use. Ensure proper testing on fork networks before mainnet deployment.

## 📜 License

MIT License - see LICENSE file for details.
