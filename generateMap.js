import fs from "fs";
import crypto from "crypto";

class DeterministicDice {
  constructor(revealHash) {
    // Strip 0x prefix and store as entropy
    this.entropy = revealHash.startsWith("0x")
      ? revealHash.slice(2)
      : revealHash;
    this.position = 0;
    console.log(`Initialized with entropy: ${this.entropy}`);
  }

  // Roll x dice (use x characters from entropy)
  roll(count = 1) {
    let result = 0;

    for (let i = 0; i < count; i++) {
      // Check if we need to rehash entropy
      if (this.position >= this.entropy.length) {
        console.log(`Rehashing entropy at position ${this.position}`);
        this.rehashEntropy();
      }

      // Get next hex character and convert to 0-15
      const hexChar = this.entropy[this.position];
      const value = parseInt(hexChar, 16);

      // For multiple dice, we'll combine them (this creates more variation)
      result = (result << 4) + value;
      this.position++;
    }

    return result;
  }

  rehashEntropy() {
    // Hash the current entropy to get new entropy
    const hash = crypto.createHash("sha256");
    hash.update(this.entropy);
    this.entropy = hash.digest("hex");
    this.position = 0;
    console.log(`New entropy: ${this.entropy}`);
  }
}

class GameLandGenerator {
  constructor(dice) {
    this.dice = dice;
    this.land = [];
    this.size = 20;
  }

  generateLand() {
    console.log("Generating 20x20 land...");

    // Initialize 20x20 array
    for (let y = 0; y < this.size; y++) {
      this.land[y] = [];
      for (let x = 0; x < this.size; x++) {
        // Roll one die (0-15)
        const roll = this.dice.roll(1);

        // Convert roll to land type
        let landType;
        if (roll <= 10) {
          landType = 1; // Common land (0-10)
        } else if (roll <= 14) {
          landType = 2; // Uncommon land (11-14)
        } else {
          landType = 3; // Rare land (15)
        }

        this.land[y][x] = landType;
      }
    }

    console.log("Land generation complete!");
  }

  placeStartingPosition() {
    // Roll 2 dice for x coordinate, mod 20
    const x = this.dice.roll(2) % this.size;
    // Roll 2 dice for y coordinate, mod 20
    const y = this.dice.roll(2) % this.size;

    console.log(`Placing starting position at (${x}, ${y})`);

    // Store original land type and place X
    this.startingPosition = { x, y, originalLandType: this.land[y][x] };
    this.land[y][x] = "X";
  }

  saveMapToFile(filename = "map.txt") {
    const mapData = {
      size: this.size,
      land: this.land,
      startingPosition: this.startingPosition,
      metadata: {
        generated: new Date().toISOString(),
        landTypes: {
          1: "Common",
          2: "Uncommon",
          3: "Rare",
          X: "Starting Position",
        },
      },
    };

    fs.writeFileSync(filename, JSON.stringify(mapData, null, 2));
    console.log(`Map saved to ${filename}`);
  }

  printMapSummary() {
    let counts = { 1: 0, 2: 0, 3: 0, X: 0 };

    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        counts[this.land[y][x]]++;
      }
    }

    console.log("\nMap Summary:");
    console.log(`Common land (1): ${counts[1]} tiles`);
    console.log(`Uncommon land (2): ${counts[2]} tiles`);
    console.log(`Rare land (3): ${counts[3]} tiles`);
    console.log(`Starting position (X): ${counts["X"]} tile`);
    console.log(
      `Total: ${counts[1] + counts[2] + counts[3] + counts["X"]} tiles`
    );
  }
}

// Main game script
function main() {
  try {
    console.log("🎮 Starting Game Land Generator...\n");

    // Read the reveal hash
    const revealHash = fs.readFileSync("reveal.txt", "utf8").trim();
    console.log(`Read reveal hash: ${revealHash}`);

    // Initialize deterministic dice
    const dice = new DeterministicDice(revealHash);

    // Test the dice system
    console.log("\n🎲 Testing dice system:");
    for (let i = 0; i < 5; i++) {
      console.log(`Roll ${i + 1}: ${dice.roll(1)}`);
    }

    // Reset dice for actual generation
    const gameGenerator = new GameLandGenerator(
      new DeterministicDice(revealHash)
    );

    // Generate the land
    gameGenerator.generateLand();

    // Place starting position
    gameGenerator.placeStartingPosition();

    // Print summary
    gameGenerator.printMapSummary();

    // Save to file
    gameGenerator.saveMapToFile("map.txt");

    console.log("\n✅ Game land generation complete!");
    console.log("Check map.txt for the generated map data.");
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { DeterministicDice, GameLandGenerator };
