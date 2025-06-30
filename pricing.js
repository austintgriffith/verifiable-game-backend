import {
  WETH_ADDRESS,
  USDC_ADDRESS,
  ETH_USDC_POOL_ADDRESS,
  DEXS,
  AERODROME_ROUTER_ABI,
  UNISWAP_V2_ROUTER_ABI,
  UNISWAP_V3_POOL_ABI,
} from "./config.js";

// Get ETH price in USDC using on-chain DEX data
export async function getEthPriceFromDEXs(publicClient) {
  console.log("📊 Getting ETH price from on-chain DEXs...");

  const oneEth = BigInt("1000000000000000000"); // 1 ETH in wei

  // Try Aerodrome first (Base's leading DEX)
  try {
    const aeroRoutes = [
      {
        from: WETH_ADDRESS,
        to: USDC_ADDRESS,
        stable: false,
        factory: DEXS.AERODROME.factory,
      },
    ];

    const aeroAmounts = await publicClient.readContract({
      address: DEXS.AERODROME.router,
      abi: AERODROME_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [oneEth, aeroRoutes],
      blockTag: "pending",
    });

    const usdcOut = Number(aeroAmounts[1]) / 1e6;
    console.log(`🌪️  Aerodrome price: $${usdcOut.toFixed(2)}/ETH`);
    return usdcOut;
  } catch (error) {
    console.log("⚠️  Aerodrome price lookup failed, trying Uniswap V2...");
  }

  // Try Uniswap V2 as backup
  try {
    const uniPath = [WETH_ADDRESS, USDC_ADDRESS];

    const uniAmounts = await publicClient.readContract({
      address: DEXS.UNISWAP_V2.router,
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [oneEth, uniPath],
      blockTag: "pending",
    });

    const usdcOut = Number(uniAmounts[1]) / 1e6;
    console.log(`🦄 Uniswap V2 price: $${usdcOut.toFixed(2)}/ETH`);
    return usdcOut;
  } catch (error) {
    console.log("⚠️  Using fallback to Uniswap V3...");
  }

  // Try Uniswap V3 as final backup using slot0
  try {
    const slot0 = await publicClient.readContract({
      address: ETH_USDC_POOL_ADDRESS,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "slot0",
      blockTag: "pending",
    });

    const sqrtPriceX96 = BigInt(slot0[0]);
    if (sqrtPriceX96 > 0n) {
      // Convert sqrtPriceX96 to price
      // price = (sqrtPriceX96 / 2^96)^2 * (10^(decimals1 - decimals0))
      // For WETH/USDC: decimals1 = 6 (USDC), decimals0 = 18 (WETH)
      const Q96 = 2n ** 96n;
      const price =
        Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(1e6)) /
        Number(Q96 * Q96 * BigInt(1e18));

      console.log(`🚀 Uniswap V3 price: $${price.toFixed(2)}/ETH`);
      return price;
    }
  } catch (v3Error) {
    console.log("⚠️  Using fallback price");
  }

  // Final fallback
  console.log("📉 Using static fallback price: $2400/ETH");
  return 2400;
}

// Silent version for account display (no console logs)
export async function getEthPriceInUsdc(publicClient) {
  // Use 1 ETH as reference amount
  const oneEth = BigInt("1000000000000000000"); // 1 ETH in wei

  // Try Aerodrome first (Base's leading DEX)
  try {
    const aeroRoutes = [
      {
        from: WETH_ADDRESS,
        to: USDC_ADDRESS,
        stable: false,
        factory: DEXS.AERODROME.factory,
      },
    ];

    const aeroAmounts = await publicClient.readContract({
      address: DEXS.AERODROME.router,
      abi: AERODROME_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [oneEth, aeroRoutes],
      blockTag: "pending",
    });

    // Convert USDC output (6 decimals) to price
    const usdcOut = Number(aeroAmounts[1]) / 1e6;
    return usdcOut;
  } catch (aeroError) {
    // Silent fallback to Uniswap V2
  }

  // Try Uniswap V2 as backup
  try {
    const uniPath = [WETH_ADDRESS, USDC_ADDRESS];

    const uniAmounts = await publicClient.readContract({
      address: DEXS.UNISWAP_V2.router,
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [oneEth, uniPath],
      blockTag: "pending",
    });

    // Convert USDC output (6 decimals) to price
    const usdcOut = Number(uniAmounts[1]) / 1e6;
    return usdcOut;
  } catch (uniError) {
    // Silent fallback to Uniswap V3
  }

  // Try Uniswap V3 as final backup using slot0
  try {
    const slot0 = await publicClient.readContract({
      address: ETH_USDC_POOL_ADDRESS,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "slot0",
      blockTag: "pending",
    });

    const sqrtPriceX96 = BigInt(slot0[0]);
    if (sqrtPriceX96 > 0n) {
      // Convert sqrtPriceX96 to price
      // price = (sqrtPriceX96 / 2^96)^2 * (10^(decimals1 - decimals0))
      // For WETH/USDC: decimals1 = 6 (USDC), decimals0 = 18 (WETH)
      const Q96 = 2n ** 96n;
      const price =
        Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(1e6)) /
        Number(Q96 * Q96 * BigInt(1e18));

      return price;
    }
  } catch (v3Error) {
    // Final fallback
  }

  // Final fallback
  return 2400;
}
