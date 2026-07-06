/**
 * src/buildings.js
 * Purpose: Building creation/removal, spawn helpers (random empty tile placement), supply/demand (waitingCount) management, wait timer increments and overload state transitions. Owns all Building data mutations and queries for the house/destination model. Overload flag is sticky (see resetOverload).
 * Expected scale: ~135 LOC. Moderate complexity from tile occupancy checks, timer side-effects, sticky overload, and spawn sampling.
 * Imports: ./config.js (BUILDING_OVERLOAD_THRESHOLD, MAX_BUILDINGS, GRID_WIDTH, GRID_HEIGHT), ./grid.js (isInBounds)
 * Exports: createBuilding, removeBuilding, findBuildingById, findBuildingAtTile, updateBuildingTimers, incrementWaitingCount, decrementWaitingCount, hasOverloadedBuilding, resetOverload, getHousesWithDemand, getDestinations, spawnHouse, spawnDestination
 */

// -----------------------------------------------------------------------------
// Imports & module state
// -----------------------------------------------------------------------------

import { BUILDING_OVERLOAD_THRESHOLD, MAX_BUILDINGS, GRID_WIDTH, GRID_HEIGHT } from './config.js';
import { isInBounds } from './grid.js';

/** @typedef {{x: number, y: number}} TileCoord */
/** @typedef {{id: string, type: 'house' | 'destination', tile: TileCoord, waitingCount: number, waitTimer: number, overloaded: boolean}} Building */

let nextBuildingId = 0;

/**
 * Generates a unique building id (module-scoped counter).
 * @returns {string}
 */
function generateBuildingId() {
  const idNum = nextBuildingId++;
  return `b_${idNum.toString().padStart(4, '0')}`;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Finds a building occupying the exact tile (if any).
 * O(B) linear scan (B = buildings.length). Acceptable: B typically << 150 and
 * calls are infrequent (spawn, input, vehicle arrival) not per-frame hot path.
 * @param {Building[]} buildings
 * @param {TileCoord} tile
 * @returns {Building|undefined}
 */
export function findBuildingAtTile(buildings, tile) {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.tile.x === tile.x && b.tile.y === tile.y) {
      return b;
    }
  }
  return undefined;
}

/**
 * Sets waitingCount with side-effect management of waitTimer.
 * - When count reaches 0: reset waitTimer=0 (demand cleared).
 * - When count rises from 0 to >0: reset waitTimer=0 to start fresh wait period.
 * - overloaded is NEVER touched here (sticky flag; only set in updateBuildingTimers, cleared only via resetOverload).
 * - Clamps to >= 0. Called only from inc/dec to keep timer consistent.
 * @param {Building} building
 * @param {number} newCount
 */
function setWaitingCount(building, newCount) {
  if (!building) return;
  const oldCount = building.waitingCount;
  building.waitingCount = Math.max(0, Math.floor(newCount));
  if (building.waitingCount === 0) {
    building.waitTimer = 0;
    // overloaded is sticky — do not auto-clear here (preserves open decision for main.js loss condition)
  } else if (oldCount === 0) {
    building.waitTimer = 0;
  }
}

/**
 * Finds a random tile with no building on it.
 * Uses limited random sampling (fast early/mid game). Returns null only if grid essentially full.
 * @param {Building[]} buildings
 * @returns {TileCoord|null}
 */
function findRandomEmptyTile(buildings) {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.floor(Math.random() * GRID_WIDTH);
    const y = Math.floor(Math.random() * GRID_HEIGHT);
    const tile = { x, y };
    if (!findBuildingAtTile(buildings, tile)) {
      return tile;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Creates and appends a new Building if tile is valid, in-bounds, unoccupied, and under MAX_BUILDINGS.
 * Houses start with waitingCount=1 (immediate demand); destinations start at 0.
 * @param {Building[]} buildings - target array (usually state.buildings)
 * @param {'house' | 'destination'} type
 * @param {TileCoord} tile
 * @returns {Building|null} newly created building or null on invalid/duplicate/full
 */
export function createBuilding(buildings, type, tile) {
  if (type !== 'house' && type !== 'destination') {
    return null;
  }
  if (!isInBounds(tile)) {
    return null;
  }
  if (findBuildingAtTile(buildings, tile)) {
    return null;
  }
  if (buildings.length >= MAX_BUILDINGS) {
    return null;
  }

  const building = {
    id: generateBuildingId(),
    type,
    tile: { x: tile.x, y: tile.y },
    waitingCount: (type === 'house' ? 1 : 0),
    waitTimer: 0,
    overloaded: false
  };

  buildings.push(building);
  return building;
}

/**
 * Removes the building with matching id if present.
 * Stranded vehicle originId/destinationId cleanup is NOT performed here — caller (vehicles.js / main.js) must handle.
 * @param {Building[]} buildings
 * @param {string} id
 * @returns {boolean} true if a building was removed
 */
export function removeBuilding(buildings, id) {
  for (let i = 0; i < buildings.length; i++) {
    if (buildings[i].id === id) {
      buildings.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Returns the Building object for the given id or undefined.
 * @param {Building[]} buildings
 * @param {string} id
 * @returns {Building|undefined}
 */
export function findBuildingById(buildings, id) {
  for (let i = 0; i < buildings.length; i++) {
    if (buildings[i].id === id) {
      return buildings[i];
    }
  }
  return undefined;
}

/**
 * Increments waitingCount for the building (clamped >=0). Manages waitTimer reset/start logic.
 * Idempotent in effect if amount=0.
 * @param {Building[]} buildings
 * @param {string} id
 * @param {number} [amount=1]
 * @returns {boolean} true if building was found and updated
 */
export function incrementWaitingCount(buildings, id, amount = 1) {
  const building = findBuildingById(buildings, id);
  if (!building) return false;
  setWaitingCount(building, building.waitingCount + (amount || 0));
  return true;
}

/**
 * Decrements waitingCount for the building (clamped >=0). Manages waitTimer reset when demand clears.
 * @param {Building[]} buildings
 * @param {string} id
 * @param {number} [amount=1]
 * @returns {boolean} true if building was found and updated
 */
export function decrementWaitingCount(buildings, id, amount = 1) {
  const building = findBuildingById(buildings, id);
  if (!building) return false;
  setWaitingCount(building, building.waitingCount - (amount || 0));
  return true;
}

/**
 * Updates waitTimer for all buildings based on elapsed simulation time.
 * Call once per fixed timestep (or accumulated dt) from main loop.
 * Increments only while waitingCount > 0; resets waitTimer when demand clears.
 * Sets overloaded=true (sticky) once waitTimer >= threshold. overloaded is never auto-cleared here.
 * O(B) with B <= 150 — negligible even at 60 Hz.
 * @param {Building[]} buildings
 * @param {number} dt - elapsed seconds (e.g. FIXED_TIMESTEP or accumulated)
 */
export function updateBuildingTimers(buildings, dt) {
  if (!dt || dt <= 0) return;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.waitingCount > 0) {
      b.waitTimer += dt;
      if (b.waitTimer >= BUILDING_OVERLOAD_THRESHOLD) {
        b.overloaded = true;
      }
    } else {
      b.waitTimer = 0;
      // overloaded is sticky (set only in this function when threshold crossed);
      // cleared only by explicit resetOverload() — preserves SPEC.md open decision for main.js
    }
  }
}

/**
 * Returns true if any building has entered the overloaded state (used by main.js loss condition).
 * O(B) scan. Acceptable in main loop.
 * @param {Building[]} buildings
 * @returns {boolean}
 */
export function hasOverloadedBuilding(buildings) {
  for (let i = 0; i < buildings.length; i++) {
    if (buildings[i].overloaded) return true;
  }
  return false;
}

/**
 * Explicitly clears the overloaded flag for a specific building (e.g. on game restart / new session in main.js).
 * Does not affect waitTimer, waitingCount, or any other state. This is the only way to clear overloaded.
 * @param {Building[]} buildings
 * @param {string} id
 * @returns {boolean} true if building was found and overload flag cleared
 */
export function resetOverload(buildings, id) {
  const building = findBuildingById(buildings, id);
  if (!building) return false;
  building.overloaded = false;
  return true;
}

/**
 * Returns houses that currently have unmet demand and are not overloaded.
 * Useful for supply/demand matching and vehicle spawn decisions (caller picks from list).
 * Note: a house that previously overloaded will still appear here only if !overloaded (but sticky overload prevents re-use until reset).
 * @param {Building[]} buildings
 * @returns {Building[]}
 */
export function getHousesWithDemand(buildings) {
  const result = [];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.type === 'house' && b.waitingCount > 0 && !b.overloaded) {
      result.push(b);
    }
  }
  return result;
}

/**
 * Returns all destination-type buildings (for destination selection in matching/spawn).
 * @param {Building[]} buildings
 * @returns {Building[]}
 */
export function getDestinations(buildings) {
  const result = [];
  for (let i = 0; i < buildings.length; i++) {
    if (buildings[i].type === 'destination') {
      result.push(buildings[i]);
    }
  }
  return result;
}

/**
 * Spawn helper: attempts to place a new house at a random empty tile.
 * Uses createBuilding internally (initial waitingCount=1).
 * @param {Building[]} buildings
 * @returns {Building|null}
 */
export function spawnHouse(buildings) {
  if (buildings.length >= MAX_BUILDINGS) return null;
  const tile = findRandomEmptyTile(buildings);
  if (!tile) return null;
  return createBuilding(buildings, 'house', tile);
}

/**
 * Spawn helper: attempts to place a new destination at a random empty tile.
 * Uses createBuilding internally (initial waitingCount=0).
 * @param {Building[]} buildings
 * @returns {Building|null}
 */
export function spawnDestination(buildings) {
  if (buildings.length >= MAX_BUILDINGS) return null;
  const tile = findRandomEmptyTile(buildings);
  if (!tile) return null;
  return createBuilding(buildings, 'destination', tile);
}
