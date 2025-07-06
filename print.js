import fs from "fs";

// File system constants
const SAVED_DIR = "saved";

// Function to print map from saved file
function printMapFromFile(filename = "map.txt") {
  try {
    const mapData = JSON.parse(fs.readFileSync(filename, "utf8"));
    const land = mapData.land;
    const size = mapData.size;

    console.log("\n🗺️  Game Map:");
    console.log(
      "Legend: . = Common(1)  ▲ = Uncommon(2)  ♦ = Rare(3)  X = Start\n"
    );

    // Print column numbers
    console.log(
      "   " +
        Array.from({ length: size }, (_, i) => (i < 10 ? " " + i : i)).join("")
    );

    for (let y = 0; y < size; y++) {
      // Print row number
      let row = (y < 10 ? " " + y : y) + " ";

      for (let x = 0; x < size; x++) {
        const tile = land[y][x];
        let symbol;

        switch (tile) {
          case 1:
            symbol = ".";
            break; // Common land
          case 2:
            symbol = "▲";
            break; // Uncommon land
          case 3:
            symbol = "♦";
            break; // Rare land
          case "X":
            symbol = "X";
            break; // Starting position
          default:
            symbol = "?";
            break;
        }

        row += symbol + " ";
      }

      console.log(row);
    }

    // Print map info
    const startPos = mapData.startingPosition;
    console.log(`\nStarting Position: (${startPos.x}, ${startPos.y})`);
    console.log(`Original Land Type: ${startPos.originalLandType}`);
    console.log(`Generated: ${mapData.metadata.generated}`);

    // Print statistics
    let counts = { 1: 0, 2: 0, 3: 0, X: 0 };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        counts[land[y][x]]++;
      }
    }

    console.log("\nMap Statistics:");
    console.log(
      `Common land (.): ${counts[1]} tiles (${((counts[1] / 400) * 100).toFixed(
        1
      )}%)`
    );
    console.log(
      `Uncommon land (▲): ${counts[2]} tiles (${(
        (counts[2] / 400) *
        100
      ).toFixed(1)}%)`
    );
    console.log(
      `Rare land (♦): ${counts[3]} tiles (${((counts[3] / 400) * 100).toFixed(
        1
      )}%)`
    );
    console.log(`Starting position (X): ${counts["X"]} tile`);
    console.log(
      `Total: ${counts[1] + counts[2] + counts[3] + counts["X"]} tiles`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(
        `❌ Map file not found. Run 'node game.js' first to generate a map in the ${SAVED_DIR} directory.`
      );
    } else {
      console.error("❌ Error reading map file:", error.message);
    }
  }
}

// Check command line arguments for custom filename
const args = process.argv.slice(2);
const filename = args[0] || `${SAVED_DIR}/map.txt`;

console.log("🎮 Map Printer");
console.log(`Reading from: ${filename}\n`);

printMapFromFile(filename);
