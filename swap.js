import { formatEther, formatUnits, parseUnits, parseEther } from "viem";
import { createClients } from "./clients.js";
import {
  USDC_ADDRESS,
  WETH_ADDRESS,
  DEXS,
  WETH_ABI,
  ERC20_ABI,
  AERODROME_ROUTER_ABI,
  UNISWAP_V2_ROUTER_ABI,
  UNISWAP_V3_ROUTER_ABI,
} from "./config.js";
import { getEthPriceFromDEXs } from "./pricing.js";

// Get quote from a specific DEX
async function getQuote(publicClient, dex, amountIn) {
  try {
    if (dex.type === "aerodrome") {
      const routes = [
        {
          from: WETH_ADDRESS,
          to: USDC_ADDRESS,
          stable: false,
          factory: dex.factory,
        },
      ];

      const amountsOut = await publicClient.readContract({
        address: dex.router,
        abi: AERODROME_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, routes],
        blockTag: "pending",
      });

      return {
        amountOut: amountsOut[1],
        routes,
        success: true,
        dex,
      };
    } else if (dex.type === "uniswap_v2") {
      const path = [WETH_ADDRESS, USDC_ADDRESS];

      const amountsOut = await publicClient.readContract({
        address: dex.router,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, path],
        blockTag: "pending",
      });

      return {
        amountOut: amountsOut[1],
        path,
        success: true,
        dex,
      };
    }

    return { success: false };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get best quote by comparing all DEXs
async function getBestQuote(publicClient, amountIn) {
  console.log("\n🔍 Finding best price across DEXs...");

  const quotes = [];

  // Get quotes from Aerodrome and Uniswap V2 (skip V3 for now since it was problematic)
  for (const dex of [DEXS.AERODROME, DEXS.UNISWAP_V2]) {
    const quote = await getQuote(publicClient, dex, amountIn);
    if (quote.success) {
      const usdcOut = formatUnits(quote.amountOut, 6);
      console.log(`${dex.emoji} ${dex.name}: ${usdcOut} USDC`);
      quotes.push(quote);
    } else {
      console.log(`❌ ${dex.name}: Failed`);
    }
  }

  if (quotes.length === 0) {
    console.log("💀 No DEX quotes available");
    return null;
  }

  // Find best quote (highest output)
  const bestQuote = quotes.reduce((best, current) =>
    current.amountOut > best.amountOut ? current : best
  );

  const bestOutput = formatUnits(bestQuote.amountOut, 6);
  console.log(
    `🏆 Best price: ${bestQuote.dex.emoji} ${bestQuote.dex.name} → ${bestOutput} USDC`
  );

  return bestQuote;
}

// Execute swap on chosen DEX
async function executeSwap(
  walletClient,
  publicClient,
  quote,
  amountIn,
  account
) {
  try {
    console.log(`\n🚀 Executing swap on ${quote.dex.name}...`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const minAmountOut = (quote.amountOut * 98n) / 100n; // 2% slippage

    let swapHash;

    if (quote.dex.type === "aerodrome") {
      swapHash = await walletClient.writeContract({
        address: quote.dex.router,
        abi: AERODROME_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountIn, minAmountOut, quote.routes, account.address, deadline],
      });
    } else if (quote.dex.type === "uniswap_v2") {
      swapHash = await walletClient.writeContract({
        address: quote.dex.router,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountIn, minAmountOut, quote.path, account.address, deadline],
      });
    }

    console.log(`${quote.dex.emoji} Swap transaction: ${swapHash}`);
    console.log(`🔗 View on BaseScan: https://basescan.org/tx/${swapHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: swapHash,
    });

    if (receipt.status === "success") {
      console.log(`✅ Swap completed successfully on ${quote.dex.name}!`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);
      return { success: true, hash: swapHash, gasUsed: receipt.gasUsed };
    } else {
      console.log(`❌ Swap failed on ${quote.dex.name}`);
      return { success: false };
    }
  } catch (error) {
    console.log(`❌ ${quote.dex.name} swap failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  try {
    // Get command line argument
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error("❌ Please provide USDC amount as argument");
      console.log("Usage: node swap.js 0.5");
      process.exit(1);
    }

    const usdcAmount = parseFloat(args[0]);
    if (isNaN(usdcAmount) || usdcAmount <= 0) {
      console.error("❌ Please provide a valid positive number");
      process.exit(1);
    }

    // Create clients and account
    const { account, publicClient, walletClient } = createClients();

    console.log(`\n🎯 Smart Swap: ETH → ${usdcAmount} USDC`);
    console.log("=====================================");
    console.log(`Account: ${account.address}`);

    // Get current balances and ETH price from DEXs
    console.log("\n💰 Getting balances and on-chain ETH price...");
    const [ethBalance, wethBalance, ethPrice] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending", // Fix for Base fork hardfork validation
      }),
      getEthPriceFromDEXs(publicClient),
    ]);

    const ethBalanceFormatted = formatEther(ethBalance);
    const wethBalanceFormatted = formatEther(wethBalance);

    console.log(`ETH Balance: ${ethBalanceFormatted} ETH`);
    console.log(`WETH Balance: ${wethBalanceFormatted} WETH`);

    // Calculate WETH needed for swap
    const estimatedWethNeeded = (usdcAmount / ethPrice) * 1.05; // 5% buffer
    const wethNeededWei = parseEther(estimatedWethNeeded.toString());

    console.log(`\n🎯 Target: ${usdcAmount} USDC`);
    console.log(
      `WETH needed: ${estimatedWethNeeded.toFixed(
        6
      )} WETH (at $${ethPrice.toFixed(2)}/ETH)`
    );

    // Wrap ETH if needed
    let finalWethAmount = wethBalance;
    if (wethBalance < wethNeededWei) {
      const additionalWethNeeded = wethNeededWei - wethBalance;
      const additionalWethFormatted = formatEther(additionalWethNeeded);

      console.log(
        `\n🔄 Step 1: Wrapping ${additionalWethFormatted} ETH to WETH...`
      );

      if (ethBalance < additionalWethNeeded) {
        console.error(
          `❌ Insufficient ETH. Need ${additionalWethFormatted} more ETH to wrap`
        );
        process.exit(1);
      }

      const wrapHash = await walletClient.writeContract({
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "deposit",
        value: additionalWethNeeded,
      });

      console.log(`Wrap transaction: ${wrapHash}`);
      await publicClient.waitForTransactionReceipt({ hash: wrapHash });
      console.log("✅ ETH wrapped to WETH");
      finalWethAmount = wethNeededWei;
    } else {
      console.log("✅ Sufficient WETH balance available");
      finalWethAmount = wethNeededWei;
    }

    // Get best quote across DEXs
    const bestQuote = await getBestQuote(publicClient, finalWethAmount);

    if (!bestQuote) {
      console.error("❌ No available quotes from any DEX");
      process.exit(1);
    }

    // Approve WETH spending for the chosen DEX
    console.log(
      `\n🔧 Step 2: Checking WETH approval for ${bestQuote.dex.name}...`
    );
    const currentAllowance = await publicClient.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "allowance",
      args: [account.address, bestQuote.dex.router],
      blockTag: "pending", // Fix for Base fork hardfork validation
    });

    if (currentAllowance < finalWethAmount) {
      console.log("Approving WETH spending...");
      const approveHash = await walletClient.writeContract({
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "approve",
        args: [bestQuote.dex.router, finalWethAmount],
      });

      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ WETH spending approved");
    } else {
      console.log("✅ WETH already approved for spending");
    }

    // Execute the swap
    const swapResult = await executeSwap(
      walletClient,
      publicClient,
      bestQuote,
      finalWethAmount,
      account
    );

    if (swapResult.success) {
      // Check final USDC balance
      const finalUsdcBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending", // Fix for Base fork hardfork validation
      });

      console.log(
        `\n🎉 Swap successful! Final USDC balance: ${formatUnits(
          finalUsdcBalance,
          6
        )} USDC`
      );
      console.log(`${bestQuote.dex.emoji} Powered by ${bestQuote.dex.name}!`);
      console.log("\n📊 Run 'node account.js' to see updated portfolio!");
    } else {
      console.error("❌ Swap failed on chosen DEX");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("insufficient funds")) {
      console.log("💡 Make sure you have enough ETH for the swap + gas fees");
    }
    process.exit(1);
  }
}

main();
