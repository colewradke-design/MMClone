/**
 * src/buildings.js
 * Purpose: Building creation/removal, spawn helpers (random empty tile placement now supporting optional road-connection avoidance for Phase 1), supply/demand (waitingCount) management, wait timer increments and overload state transitions. Color assignment in creation. Owns all Building data mutations and queries. Overload flag is sticky.
 * Expected scale: ~158 LOC (~13 LOC growth from private helper, param plumbing on 3 functions, and JSDoc updates). Still moderate complexity.
 * Imports: ./config.js (BUILDING_OVERLOAD_THRESHOLD, MAX_BUILDINGS, GRID_WIDTH, GRID_HEIGHT, BUILDING_COLORS), ./grid.js (isInBounds)
 * Exports: createBuilding, removeBuilding, findBuildingById, findBuildingAtTile, updateBuildingTimers, incrementWaitingCount, decrementWaitingCount, hasOverloadedBuilding, resetOverload, getHousesWithDemand, getDestinations, getDestinationsByColor, spawnHouse, spawnDestination
 * (No new public exports. All existing signatures and 1-argument call behavior preserved exactly.)
 */

/**
 * Phase 1 of remediation plan (prevent houses from spawning on tiles that already have road connections):
 * - Added private (non-exported) helper tileHasAnyRoadConnection(roads, tile) — O(R) linear scan.
 * - findRandomEmptyTile now accepts optional second param roads = [].
 * - spawnHouse and spawnDestination now accept optional second param roads = [] and forward it.
 * - When roads param is omitted (current main.js call sites), behavior is 100% identical to the version delivered in previous chat.
 * - Road check is implemented internally with linear scan (no new export or dependency on roads.js yet).
 * - Future phases will update call sites in main.js to pass state.roads (this file change is isolated and non-breaking).
 * - Engine-agnostic, plain objects/arrays only, zero per-frame allocations.
 */

// -----------------------------------------------------------------------------
// Imports & module state
// -----------------------------------------------------------------------------

import { BUILDING_OVERLOAD_THRESHOLD, MAX_BUILDINGS, GRID_WIDTH, GRID_HEIGHT, BUILDING_COLORS } from './config.js';
import { isInBounds } from './grid.js';

/** @typedef {{x: number, y: number}} TileCoord */
/** @typedef {{id: string, type: 'house' | 'destination', tile: TileCoord, waitingCount: number, waitTimer: number, overloaded: boolean, color?: 'red' | 'blue' | 'green' | 'yellow' | 'purple'}} Building */

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
 * Returns true if the given tile is used as the 'from' or 'to' of any road in the array.
 * O(R) linear scan — acceptable because this runs only during infrequent building spawns.
 * @param {Array<{from: TileCoord, to: TileCoord}>} roads
 * @param {TileCoord} tile
 * @returns {boolean}
 */
function tileHasAnyRoadConnection(roads, tile) {
  if (!Array.isArray(roads) || roads.length === 0 || !tile) return false;
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || !r.from || !r.to) continue;
    if ((r.from.x === tile.x && r.from.y === tile.y) ||
        (r.to.x === tile.x && r.to.y === tile.y)) {
      return true;
    }
  }
  return false;
}

/**
 * Finds a random tile with no building on it (and optionally no road connection).
 * Uses limited random sampling (fast early/mid game). Returns null only if grid essentially full.
 * When roads array is provided and non-empty, any tile that is an endpoint of a road is rejected.
 * Road check costs O(R) per attempt (R = roads.length) but is only executed during infrequent spawns.
 * @param {Building[]} buildings
 * @param {Array<{from: TileCoord, to: TileCoord}>} [roads=[]]
 * @returns {TileCoord|null}
 */
function findRandomEmptyTile(buildings, roads = []) {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.floor(Math.random() * GRID_WIDTH);
    const y = Math.floor(Math.random() * GRID_HEIGHT);
    const tile = { x, y };
    if (findBuildingAtTile(buildings, tile)) {
      continue;
    }
    if (Array.isArray(roads) && roads.length > 0 && tileHasAnyRoadConnection(roads, tile)) {
      continue;
    }
    return tile;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Creates and appends a new Building if tile is valid, in-bounds, unoccupied, and under MAX_BUILDINGS.
 * All buildings (house + destination) now start with waitingCount=0 under the round-trip model.
 * Demand is seeded and incremented exclusively on destinations via main.js + incrementWaitingCount;
 * houses no longer represent demand sources. Color assignment unchanged.
 * Old buildings without color field (from pre-color createInitialState) are not created here anymore — creation always emits color.
 * Note: createBuilding itself only enforces no-building-at-tile (plus bounds/max). The optional "no road connection" filter
 * is applied upstream in findRandomEmptyTile / spawnHouse / spawnDestination when a roads array is passed.
 * @param {Building[]} buildings - target array (usually state.buildings)
 * @param {'house' | 'destination'} type
 * @param {TileCoord} tile
 * @param {'red'|'blue'|'green'|'yellow'|'purple'} [color] - optional explicit color
 * @returns {Building|null} newly created building or null on invalid/duplicate/full
 */
export function createBuilding(buildings, type, tile, color) {
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

  // Color assignment (defensive + requirement)
  let assignedColor = color;
  if (!assignedColor || typeof assignedColor !== 'string' || !BUILDING_COLORS.includes(assignedColor)) {
    assignedColor = BUILDING_COLORS[Math.floor(Math.random() * BUILDING_COLORS.length)];
  }

  const building = {
    id: generateBuildingId(),
    type,
    tile: { x: tile.x, y: tile.y },
    waitingCount: 0,
    waitTimer: 0,
    overloaded: false,
    color: assignedColor
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
 * Color is ignored (houses may have any color; demand matching does not filter by color).
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
 * Color is not filtered here; use getDestinationsByColor when color-specific matching is required.
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
 * Returns only destination buildings whose color matches the given color.
 * Defensive: if a destination somehow lacks color field (legacy data), it is treated as 'red'.
 * @param {Building[]} buildings
 * @param {'red'|'blue'|'green'|'yellow'|'purple'} color
 * @returns {Building[]}
 */
export function getDestinationsByColor(buildings, color) {
  const result = [];
  if (!color || typeof color !== 'string') return result;
  if (!BUILDING_COLORS.includes(color)) return result;

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.type === 'destination') {
      const bColor = b.color || 'red'; // graceful fallback for pre-color buildings
      if (bColor === color) {
        result.push(b);
      }
    }
  }
  return result;
}

/**
 * Spawn helper: attempts to place a new house at a random empty tile (optionally avoiding road-connected tiles).
 * Uses createBuilding internally (initial waitingCount=0, color auto-assigned).
 * If roads param is provided and non-empty, only tiles with no building AND no road endpoint are considered.
 * When roads is omitted (or empty), behaves exactly as before — permissive spawning on any empty tile.
 * @param {Building[]} buildings
 * @param {Array<{from: TileCoord, to: TileCoord}>} [roads=[]]
 * @returns {Building|null}
 */
export function spawnHouse(buildings, roads = []) {
  if (buildings.length >= MAX_BUILDINGS) return null;
  const tile = findRandomEmptyTile(buildings, roads);
  if (!tile) return null;
  return createBuilding(buildings, 'house', tile);
}

/**
 * Spawn helper: attempts to place a new destination at a random empty tile (optionally avoiding road-connected tiles).
 * Uses createBuilding internally (initial waitingCount=0, color auto-assigned).
 * If roads param is provided and non-empty, only tiles with no building AND no road endpoint are considered.
 * When roads is omitted (or empty), behaves exactly as before — permissive spawning on any empty tile.
 * @param {Building[]} buildings
 * @param {Array<{from: TileCoord, to: TileCoord}>} [roads=[]]
 * @returns {Building|null}
 */
export function spawnDestination(buildings, roads = []) {
  if (buildings.length >= MAX_BUILDINGS) return null;
  const tile = findRandomEmptyTile(buildings, roads);
  if (!tile) return null;
  return createBuilding(buildings, 'destination', tile);
}
