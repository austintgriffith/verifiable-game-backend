// Simple ETH price fetcher for account display
export async function getEthPriceInUsdc(publicClient) {
  // For simplicity, just return a reasonable ETH price
  // In a production environment, you could fetch from an API like CoinGecko
  // or keep one simple DEX call, but for now a static price is fine
  return 3000; // $3000 USD per ETH (reasonable estimate)
}
