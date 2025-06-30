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
} from "./config.js";
import { getEthPriceFromDEXs } from "./pricing.js";

// Get quote for USDC → WETH swap
async function getQuoteUsdcToWeth(publicClient, dex, amountIn) {
  try {
    if (dex.type === "aerodrome") {
      const routes = [
        {
          from: USDC_ADDRESS,
          to: WETH_ADDRESS,
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
      const path = [USDC_ADDRESS, WETH_ADDRESS];

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

// Get best quote for USDC → WETH
async function getBestQuoteUsdcToWeth(publicClient, amountIn) {
  console.log("\n🔍 Finding best price for USDC → WETH...");

  const quotes = [];

  // Get quotes from Aerodrome and Uniswap V2
  for (const dex of [DEXS.AERODROME, DEXS.UNISWAP_V2]) {
    const quote = await getQuoteUsdcToWeth(publicClient, dex, amountIn);
    if (quote.success) {
      const wethOut = formatEther(quote.amountOut);
      console.log(`${dex.emoji} ${dex.name}: ${wethOut} WETH`);
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

  const bestOutput = formatEther(bestQuote.amountOut);
  console.log(
    `🏆 Best price: ${bestQuote.dex.emoji} ${bestQuote.dex.name} → ${bestOutput} WETH`
  );

  return bestQuote;
}

// Execute USDC → WETH swap
async function executeUsdcToWethSwap(
  walletClient,
  publicClient,
  quote,
  amountIn,
  account
) {
  try {
    console.log(`\n🚀 Executing USDC → WETH swap on ${quote.dex.name}...`);
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
      console.log(`✅ USDC → WETH swap completed successfully!`);
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
      console.error("❌ Please provide USD amount as argument");
      console.log("Usage: node swapBack.js 0.25");
      process.exit(1);
    }

    const usdAmount = parseFloat(args[0]);
    if (isNaN(usdAmount) || usdAmount <= 0) {
      console.error("❌ Please provide a valid positive number");
      process.exit(1);
    }

    // Create clients and account
    const { account, publicClient, walletClient } = createClients();

    console.log(`\n🔄 Smart Swap Back: $${usdAmount} → ETH`);
    console.log("=======================================");
    console.log(`Account: ${account.address}`);

    // Get current balances and ETH price from DEXs
    console.log("\n💰 Getting balances and on-chain ETH price...");
    const [ethBalance, wethBalance, usdcBalance, ethPrice] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending", // Fix for Base fork hardfork validation
      }),
      publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending", // Fix for Base fork hardfork validation
      }),
      getEthPriceFromDEXs(publicClient),
    ]);

    const ethBalanceFormatted = formatEther(ethBalance);
    const wethBalanceFormatted = formatEther(wethBalance);
    const usdcBalanceFormatted = formatUnits(usdcBalance, 6);

    console.log(`ETH Balance: ${ethBalanceFormatted} ETH`);
    console.log(`WETH Balance: ${wethBalanceFormatted} WETH`);
    console.log(`USDC Balance: ${usdcBalanceFormatted} USDC`);

    // Calculate WETH needed with better precision handling
    const wethNeeded = usdAmount / ethPrice;
    const wethNeededWei = parseEther(wethNeeded.toFixed(18)); // Use fixed precision

    console.log(`\n🎯 Target: $${usdAmount} worth of ETH`);
    console.log(
      `WETH needed: ${wethNeeded.toFixed(8)} WETH (at $${ethPrice.toFixed(
        2
      )}/ETH)`
    );

    let finalWethBalance = wethBalance;

    // Check if we need to swap USDC → WETH
    if (wethBalance < wethNeededWei) {
      const additionalWethNeeded = wethNeededWei - wethBalance;
      const additionalWethFormatted = formatEther(additionalWethNeeded);

      // Calculate USDC needed for the additional WETH
      const usdcNeeded =
        (Number(additionalWethNeeded) / 1e18) * ethPrice * 1.05; // 5% buffer for slippage
      const usdcNeededWei = parseUnits(usdcNeeded.toString(), 6);

      console.log(`\n📊 Need ${additionalWethFormatted} more WETH`);
      console.log(`USDC needed: ${usdcNeeded.toFixed(6)} USDC`);

      // Check if we have enough USDC
      if (usdcBalance < usdcNeededWei) {
        console.error(
          `❌ Insufficient USDC. Need ${usdcNeeded.toFixed(
            6
          )} USDC but only have ${usdcBalanceFormatted}`
        );
        process.exit(1);
      }

      // Get best quote for USDC → WETH
      const bestQuote = await getBestQuoteUsdcToWeth(
        publicClient,
        usdcNeededWei
      );

      if (!bestQuote) {
        console.error("❌ No available quotes for USDC → WETH swap");
        process.exit(1);
      }

      // Approve USDC spending for the chosen DEX
      console.log(
        `\n🔧 Step 1: Checking USDC approval for ${bestQuote.dex.name}...`
      );
      const currentAllowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, bestQuote.dex.router],
        blockTag: "pending", // Fix for Base fork hardfork validation
      });

      if (currentAllowance < usdcNeededWei) {
        console.log("Approving USDC spending...");
        const approveHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [bestQuote.dex.router, usdcNeededWei],
        });

        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        console.log("✅ USDC spending approved");
      } else {
        console.log("✅ USDC already approved for spending");
      }

      // Execute the USDC → WETH swap
      const swapResult = await executeUsdcToWethSwap(
        walletClient,
        publicClient,
        bestQuote,
        usdcNeededWei,
        account
      );

      if (!swapResult.success) {
        console.error("❌ USDC → WETH swap failed");
        process.exit(1);
      }

      // Update WETH balance after swap
      finalWethBalance = await publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending", // Fix for Base fork hardfork validation
      });

      console.log(`✅ New WETH balance: ${formatEther(finalWethBalance)} WETH`);
    } else {
      console.log("✅ Sufficient WETH balance available");
    }

    // Unwrap WETH to ETH
    const wethToUnwrap =
      wethNeededWei > finalWethBalance ? finalWethBalance : wethNeededWei;
    const wethToUnwrapFormatted = formatEther(wethToUnwrap);

    console.log(
      `\n🔄 Step 2: Unwrapping ${wethToUnwrapFormatted} WETH to ETH...`
    );

    if (wethToUnwrap === 0n) {
      console.error(
        "❌ Cannot unwrap 0 WETH. Check your target amount and current balances."
      );
      process.exit(1);
    }

    const unwrapHash = await walletClient.writeContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "withdraw",
      args: [wethToUnwrap],
    });

    console.log(`Unwrap transaction: ${unwrapHash}`);
    console.log(`🔗 View on BaseScan: https://basescan.org/tx/${unwrapHash}`);

    // Wait for confirmation
    const unwrapReceipt = await publicClient.waitForTransactionReceipt({
      hash: unwrapHash,
    });

    if (unwrapReceipt.status === "success") {
      console.log("✅ WETH unwrapped to ETH successfully!");
      console.log(`Gas used: ${unwrapReceipt.gasUsed.toString()}`);

      // Check final ETH balance
      const finalEthBalance = await publicClient.getBalance({
        address: account.address,
      });
      const finalEthFormatted = formatEther(finalEthBalance);

      console.log(
        `\n🎉 Swap back completed! Final ETH balance: ${finalEthFormatted} ETH`
      );
      console.log("🔄 Successfully converted back to ETH!");
      console.log("\n📊 Run 'node account.js' to see updated portfolio!");
    } else {
      console.error("❌ WETH unwrap failed");
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("insufficient funds")) {
      console.log(
        "💡 Make sure you have enough USDC/WETH for the swap back + gas fees"
      );
    }
    process.exit(1);
  }
}

main();
