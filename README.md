# Admin Scripts

DeFi trading scripts that work on both Base mainnet and Base localhost fork.

## Setup

1. Install dependencies:

```bash
yarn install
```

2. Create a `.env` file with your configuration:

**For Base Fork (Localhost):**

```bash
PRIVKEY=your_private_key_here
CHAIN_ID=31337
ALCHEMY_API_KEY=http://localhost:8545
CONTRACT_ADDRESS=your_contract_address_here  # For commit-reveal scripts
```

**For Base Mainnet:**

```bash
PRIVKEY=your_private_key_here
CHAIN_ID=8453
ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/your-api-key
CONTRACT_ADDRESS=your_contract_address_here  # For commit-reveal scripts
```

## Network Configuration

### Base Mainnet

```bash
CHAIN_ID=8453
ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/your-api-key
```

### Base Fork (Localhost)

```bash
CHAIN_ID=31337  # Fork uses chain ID 31337
ALCHEMY_API_KEY=http://localhost:8545
```

**✅ Working:** Base forks use chain ID 31337 and maintain all Base contract addresses. The scripts automatically handle the fork's hardfork validation using `blockTag: "pending"`.

## Available Scripts

### Check Account Balance

```bash
yarn account
# or
node account.js
```

Displays your ETH, WETH, and USDC balances with portfolio value.

### Swap ETH → USDC

```bash
yarn swap 100  # Swap ETH for $100 worth of USDC
# or
node swap.js 100
```

Smart swap that finds the best price across Aerodrome and Uniswap V2.

### Swap Back USDC → ETH

```bash
yarn swap-back 50  # Swap $50 worth back to ETH
# or
node swapBack.js 50
```

Converts USDC back to ETH and unwraps to native ETH.

### Commit-Reveal System

Generate secure randomness using a commit-reveal scheme:

```bash
yarn commit  # Commit a random hash
# or
node commit.js
```

Generates a random value, commits its hash to the contract, and saves the reveal value to `reveal.txt`.

```bash
yarn reveal  # Reveal the committed value
# or
node reveal.js
```

Reads the reveal value from `reveal.txt` and reveals it to generate secure randomness.

**Usage Flow:**

1. Run `yarn commit` to commit a hash
2. Wait for the next block
3. Run `yarn reveal` to reveal and generate randomness
4. Use `--reset` flag with commit to reset if needed: `node commit.js --reset`

## Supported DEXs

- 🌪️ **Aerodrome Finance** (Primary)
- 🦄 **Uniswap V2** (Backup)

The scripts automatically find the best price across all supported DEXs.

## Contract Addresses (Base Mainnet & Fork)

- **USDC:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **WETH:** `0x4200000000000000000000000000000000000006`
- **Aerodrome Router:** `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- **Uniswap V2 Router:** `0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24`

## Usage Examples

```bash
# Switch to fork mode
# Update .env: CHAIN_ID=31337, ALCHEMY_API_KEY=http://localhost:8545
yarn account

# Switch to mainnet mode
# Update .env: CHAIN_ID=8453, ALCHEMY_API_KEY=https://base-mainnet.g.alchemy.com/v2/...
yarn account

# Swap on either network
yarn swap 500   # $500 worth of USDC
yarn swap-back 200  # $200 back to ETH

# Generate secure randomness
yarn commit     # Commit a hash
yarn reveal     # Reveal and generate randomness
```

## Fork vs Mainnet

Switch between networks by updating your `.env` file:

- **Fork (31337):** All Base contracts at same addresses, localhost RPC
- **Mainnet (8453):** Production Base network

The scripts automatically detect your configuration and work identically on both networks.

## Troubleshooting

1. **Fork connection issues:** Ensure your Base fork is running on port 8545
2. **Mainnet connection issues:** Verify your RPC URL in `ALCHEMY_API_KEY`
3. **Transaction failures:** Check you have sufficient ETH for gas + swap amounts
4. **Import errors:** Ensure all dependencies are installed with `yarn install`
5. **Contract call errors:** Scripts use `blockTag: "pending"` to handle fork hardfork validation

## Technical Notes

- Fork hardfork validation is handled automatically using `blockTag: "pending"`
- Contract addresses are identical on both networks (Base mainnet and fork)
- Switch networks by changing just `CHAIN_ID` and `ALCHEMY_API_KEY` in `.env`
