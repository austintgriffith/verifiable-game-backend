import { formatEther, formatUnits } from "viem";
import qrcode from "qrcode-terminal";
import { createClients } from "./clients.js";
import { USDC_ADDRESS, WETH_ADDRESS, ERC20_ABI } from "./config.js";
import { getEthPriceInUsdc } from "./pricing.js";

async function main() {
  try {
    // Create clients and account
    const { account, publicClient } = createClients();

    // Generate QR code for the address
    qrcode.generate(account.address, { small: true });

    // Get all balances and ETH price
    const [balance, ethPrice, wethBalance, usdcBalance] = await Promise.all([
      publicClient.getBalance({
        address: account.address,
      }),
      getEthPriceInUsdc(publicClient),
      publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending",
      }),
      publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockTag: "pending",
      }),
    ]);

    const balanceInEth = formatEther(balance);
    const balanceInUsd = (parseFloat(balanceInEth) * ethPrice).toFixed(2);

    const balanceInWeth = formatEther(wethBalance);
    const wethUsdValue = (parseFloat(balanceInWeth) * ethPrice).toFixed(2);

    const balanceInUsdc = formatUnits(usdcBalance, 6);

    // Calculate total portfolio value
    const totalUsdValue =
      parseFloat(balanceInUsd) +
      parseFloat(wethUsdValue) +
      parseFloat(balanceInUsdc);

    console.log(`\nETH ${balanceInEth} (($${balanceInUsd}))`);
    console.log(`WETH ${balanceInWeth} (($${wethUsdValue}))`);
    console.log(`USDC ${balanceInUsdc} (($${balanceInUsdc}))`);
    console.log(`-----`);
    console.log(`TOTAL ($${totalUsdValue.toFixed(2)})`);
    console.log(``);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
