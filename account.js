import { formatEther } from "viem";
import qrcode from "qrcode-terminal";
import { createClients } from "./clients.js";
import { getEthPriceInUsdc } from "./pricing.js";

async function main() {
  try {
    // Create clients and account
    const { account, publicClient } = createClients();

    // Generate QR code for the address
    qrcode.generate(account.address, { small: true });

    // Get ETH balance and price
    const [balance, ethPrice] = await Promise.all([
      publicClient.getBalance({
        address: account.address,
      }),
      getEthPriceInUsdc(publicClient),
    ]);

    const balanceInEth = formatEther(balance);
    const balanceInUsd = (parseFloat(balanceInEth) * ethPrice).toFixed(2);

    console.log(`\nETH ${balanceInEth} ($${balanceInUsd})`);
    console.log(``);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
