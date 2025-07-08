import { FULL_CONTRACT_ABI, GamePhase } from "./constants.js";
import { log } from "./utils.js";

// Event listening and game discovery functions

export async function scanForExistingGames(
  globalPublicClient,
  globalContractAddress,
  globalAccount,
  gameStates
) {
  try {
    log(`🔍 Scanning for existing games where we are gamemaster...`);

    const gameCreatedEvents = await globalPublicClient.getContractEvents({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameCreated",
      args: {
        gamemaster: globalAccount.address,
      },
      fromBlock: 0n,
      toBlock: "latest",
    });

    log(`📋 Found ${gameCreatedEvents.length} existing games`);

    for (const event of gameCreatedEvents) {
      const gameId = event.args.gameId.toString();
      const gamemaster = event.args.gamemaster;
      const creator = event.args.creator;
      const stakeAmount = event.args.stakeAmount;

      log(`📋 Processing existing game ${gameId}`, gameId);
      log(`  Gamemaster: ${gamemaster}`, gameId);
      log(`  Creator: ${creator}`, gameId);
      log(`  Stake: ${Number(stakeAmount) / 1e18} ETH`, gameId);

      gameStates.set(gameId, {
        gameId,
        gamemaster,
        creator,
        stakeAmount,
        phase: GamePhase.CREATED,
        lastUpdated: Date.now(),
      });
    }

    log(`✅ Scanned and loaded ${gameCreatedEvents.length} existing games`);
    return gameCreatedEvents.length;
  } catch (error) {
    log(`❌ Error scanning for existing games: ${error.message}`);
    return 0;
  }
}

export async function setupEventListeners(
  globalPublicClient,
  globalContractAddress,
  globalAccount,
  gameStates
) {
  try {
    log(`📡 Setting up event listeners...`);
    log(
      `🎯 Listening for games where we are gamemaster: ${globalAccount.address}`
    );

    // Listen for GameCreated events (new games)
    const unsubscribeGameCreated = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameCreated",
      args: {
        gamemaster: globalAccount.address,
      },
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const gamemaster = eventLog.args.gamemaster;
          const creator = eventLog.args.creator;
          const stakeAmount = eventLog.args.stakeAmount;

          log(`🎮 NEW game created! Game ID: ${gameId}`, gameId);
          log(`  Gamemaster: ${gamemaster}`, gameId);
          log(`  Creator: ${creator}`, gameId);
          log(`  Stake: ${Number(stakeAmount) / 1e18} ETH`, gameId);

          gameStates.set(gameId, {
            gameId,
            gamemaster,
            creator,
            stakeAmount,
            phase: GamePhase.CREATED,
            lastUpdated: Date.now(),
          });
        });
      },
    });

    // Listen for GameClosed events
    const unsubscribeGameClosed = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameClosed",
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const startTime = eventLog.args.startTime;
          const mapSize = eventLog.args.mapSize;
          const eventGameState = gameStates.get(gameId);

          if (eventGameState) {
            log(`🔒 Game closed! Game ID: ${gameId}`, gameId);
            log(`📐 Map size calculated: ${mapSize}x${mapSize}`, gameId);
            log(
              `⏰ Game start time: ${new Date(
                Number(startTime) * 1000
              ).toISOString()}`,
              gameId
            );
            eventGameState.phase = GamePhase.CLOSED;
            eventGameState.mapSize = Number(mapSize);
            eventGameState.lastUpdated = Date.now();
            gameStates.set(gameId, eventGameState);
          }
        });
      },
    });

    // Listen for HashCommitted events (to track our commits)
    const unsubscribeHashCommitted = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "HashCommitted",
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const commitGameState = gameStates.get(gameId);

          if (commitGameState) {
            log(`📝 Hash committed for game ${gameId}`, gameId);
            commitGameState.phase = GamePhase.COMMITTED;
            commitGameState.lastUpdated = Date.now();
            gameStates.set(gameId, commitGameState);
          }
        });
      },
    });

    // Listen for GameOpened events (when game becomes open for players)
    const unsubscribeGameOpened = globalPublicClient.watchContractEvent({
      address: globalContractAddress,
      abi: FULL_CONTRACT_ABI,
      eventName: "GameOpened",
      onLogs: (logs) => {
        logs.forEach((eventLog) => {
          const gameId = eventLog.args.gameId.toString();
          const openGameState = gameStates.get(gameId);

          if (openGameState) {
            log(`🔓 Game opened for players! Game ID: ${gameId}`, gameId);
            log(`👥 Players can now join the game`, gameId);
            openGameState.lastUpdated = Date.now();
            gameStates.set(gameId, openGameState);
          }
        });
      },
    });

    log(`✅ Event listeners set up successfully`);
    return [
      unsubscribeGameCreated,
      unsubscribeGameClosed,
      unsubscribeHashCommitted,
      unsubscribeGameOpened,
    ];
  } catch (error) {
    log(`❌ Error setting up event listeners: ${error.message}`);
    return [];
  }
}
