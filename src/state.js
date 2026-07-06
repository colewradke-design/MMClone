// src/state.js
// Purpose: Defines the canonical GameState data shape and provides IndexedDB-backed save/load persistence.
// Expected scale: small module (~70 LOC). Pure data + persistence layer, zero game logic or mutation helpers.
// Imports: ./config.js (GRID_WIDTH, GRID_HEIGHT only — for initial state construction)
// Exports: createInitialState, saveGameState, loadGameState

import { GRID_WIDTH, GRID_HEIGHT } from './config.js';

/**
 * @typedef {Object} TileCoord
 * @property {number} x - integer tile column
 * @property {number} y - integer tile row
 */

/**
 * Road edge (8-directional, single-file occupancy queue).
 * Matches Mini Motorways road model.
 * @typedef {Object} Road
 * @property {string} id                // e.g. 'r_0001'
 * @property {TileCoord} from
 * @property {TileCoord} to
 * @property {number} capacity
 * @property {string[]} occupantIds     // Vehicle.id in travel order (front of edge first)
 */

/**
 * Building (house = demand, destination/factory = supply).
 * @typedef {Object} Building
 * @property {string} id
 * @property {'house' | 'destination'} type
 * @property {TileCoord} tile
 * @property {number} waitingCount      // current unmet demand count
 * @property {number} waitTimer         // seconds since oldest wait started (for overload)
 * @property {boolean} overloaded
 * @property {'red' | 'blue' | 'green' | 'yellow' | 'purple'} color
 */

/**
 * Vehicle in the object pool.
 * @typedef {Object} Vehicle
 * @property {string} id
 * @property {boolean} active           // false = available in pool
 * @property {string|null} originId     // Building.id
 * @property {string|null} destinationId
 * @property {TileCoord[]} path         // current planned route (tile coords)
 * @property {number} pathIndex         // index into path of current edge start
 * @property {number} progress          // 0..1 along current edge
 * @property {number} speed             // current tiles/sec (post-congestion)
 * @property {number} personality       // 0=shortest-path bias … 1=avoid-congestion bias
 * @property {number} rerouteTimer      // accumulates toward PATHFINDING_RECOMPUTE_INTERVAL_MS
 */

/**
 * Root game state container. JSON-serializable for IndexedDB.
 * @typedef {Object} GameState
 * @property {number} tick
 * @property {number} gridWidth
 * @property {number} gridHeight
 * @property {Road[]} roads
 * @property {Building[]} buildings
 * @property {Vehicle[]} vehicles
 * @property {number} score
 * @property {boolean} gameOver
 */

// -----------------------------------------------------------------------------
// Persistence (IndexedDB)
// -----------------------------------------------------------------------------

const DB_NAME = 'mini-motorways-pwa';
const STORE_NAME = 'gameState';
const SAVE_KEY = 'save_v1';
const DB_VERSION = 1;

let dbPromise = null;

/**
 * Opens (or creates) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  return dbPromise;
}

/**
 * Saves the full GameState to IndexedDB under the canonical key.
 * The state object is cloned by structured clone algorithm (no functions/circular refs).
 * @param {GameState} state
 * @returns {Promise<void>}
 */
export async function saveGameState(state) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(state, SAVE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Loads the previously saved GameState (or null if none exists).
 * @returns {Promise<GameState|null>}
 */
export async function loadGameState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(SAVE_KEY);

    request.onsuccess = (event) => {
      const result = event.target.result || null;
      // Migration for color identity: any loaded Building missing `color` (pre-color saves)
      // gets default 'red'. This keeps old sessions playable without crashing on shape mismatch.
      // New buildings created via createInitialState still omit color (per task constraints).
      if (result && Array.isArray(result.buildings)) {
        for (let i = 0; i < result.buildings.length; i++) {
          const b = result.buildings[i];
          if (b && typeof b.color === 'undefined') {
            b.color = 'red';
          }
        }
      }
      resolve(result);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// -----------------------------------------------------------------------------
// Initial state factory
// -----------------------------------------------------------------------------

/**
 * Returns a brand-new GameState ready for a fresh game session.
 * Arrays are empty; population of vehicles, buildings and roads is performed
 * by the respective modules (vehicles.js, buildings.js, roads.js) after creation.
 * @returns {GameState}
 */
export function createInitialState() {
  return {
    tick: 0,
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    roads: [],
    buildings: [],
    vehicles: [],
    score: 0,
    gameOver: false,
  };
}
