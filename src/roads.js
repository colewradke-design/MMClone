/**
 * src/roads.js
 * Purpose: Road creation/removal, edge occupancy queue management, capacity and congestion speed factor calculation. Owns all Road data mutations and queries for the undirected 8-directional edge model. Internal normalized-edge Map provides O(1) lookup for findRoadBetween (and wrappers getOccupancyForEdge/getSpeedFactorForEdge) while preserving exact public contract.
 * Expected scale: ~160 LOC. Added Map + helpers + lazy rebuild for load compatibility; hot-path elimination is the only behavior change.
 * Imports: ./config.js (ROAD_EDGE_CAPACITY, ROAD_MIN_SPEED_FACTOR), ./grid.js (isValidEdge)
 * Exports: createRoad, removeRoad, findRoadBetween, addVehicleToEdge, removeVehicleFromEdge, getOccupancy, getSpeedFactor, getOccupancyForEdge, getSpeedFactorForEdge, invalidateEdgeMap
 *
 * Performance (updated): findRoadBetween is now O(1) average-case via Map (was O(R) linear). getOccupancyForEdge and getSpeedFactorForEdge are now O(1). This removes the per-call linear factor from pathfinding.js and vehicles.js. Their Big-O comments can be corrected in a future pass.
 * New public function `invalidateEdgeMap()` must be called by main.js after any roads array reference replacement (loadGameState, restart, etc.). See Known limitations.
 */

// -----------------------------------------------------------------------------
// Imports & module state
// -----------------------------------------------------------------------------

import { ROAD_EDGE_CAPACITY, ROAD_MIN_SPEED_FACTOR } from './config.js';
import { isValidEdge } from './grid.js';

/** @typedef {{x: number, y: number}} TileCoord */
/** @typedef {{id: string, from: TileCoord, to: TileCoord, capacity: number, occupantIds: string[]}} Road */

// Private O(1) index: normalized undirected edge key -> Road reference.
// Populated only by createRoad, pruned by removeRoad. Lazy-rebuilt on first query if empty.
let edgeMap = new Map();

let nextRoadId = 0;

/**
 * Generates a unique road id (module-scoped counter).
 * @returns {string}
 */
function generateRoadId() {
  const idNum = nextRoadId++;
  return `r_${idNum.toString().padStart(4, '0')}`;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Returns a normalized undirected edge key using the same string lexicographic
 * comparison already used by createRoad (and vehicles.js getNormalizedEdgeKey).
 * Guarantees identical key for both travel directions of the same edge.
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {string}
 */
function getNormalizedEdgeKey(from, to) {
  const fromKey = `${from.x},${from.y}`;
  const toKey = `${to.x},${to.y}`;
  if (fromKey < toKey) {
    return `${fromKey}-${toKey}`;
  }
  return `${toKey}-${fromKey}`;
}

/**
 * Rebuilds edgeMap from the supplied roads array. Only invoked when edgeMap.size === 0
 * but roads data exists (handles IndexedDB loadGameState direct array population and
 * any external direct mutation that left the map empty). O(R) cost is paid once.
 * @param {Road[]} roads
 */
function rebuildEdgeMap(roads) {
  edgeMap.clear();
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (r && r.from && r.to) {
      const key = getNormalizedEdgeKey(r.from, r.to);
      if (!edgeMap.has(key)) {
        edgeMap.set(key, r);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Creates and appends a new Road if the edge is geometrically valid and does not already exist.
 * Stores the edge in normalized order (lexicographically smaller tile key first) to keep from/to consistent.
 * Also inserts into the O(1) edgeMap.
 * @param {Road[]} roads - target array (usually state.roads)
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {Road|null} newly created road or null on invalid/duplicate
 */
export function createRoad(roads, from, to) {
  if (!isValidEdge(from, to)) {
    return null;
  }
  if (findRoadBetween(roads, from, to)) {
    return null;
  }

  // Normalize storage order (smaller string key first)
  let start = { x: from.x, y: from.y };
  let end = { x: to.x, y: to.y };
  const fromKey = `${from.x},${from.y}`;
  const toKey = `${to.x},${to.y}`;
  if (fromKey > toKey) {
    start = { x: to.x, y: to.y };
    end = { x: from.x, y: from.y };
  }

  const road = {
    id: generateRoadId(),
    from: start,
    to: end,
    capacity: ROAD_EDGE_CAPACITY,
    occupantIds: []
  };

  roads.push(road);
  const mapKey = getNormalizedEdgeKey(start, end);
  edgeMap.set(mapKey, road);
  return road;
}

/**
 * Removes the road connecting from↔to (either direction) if present.
 * Removes from both the roads array and the edgeMap. Occupant cleanup is NOT performed here.
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {boolean} true if a road was removed
 */
export function removeRoad(roads, from, to) {
  const normKey = getNormalizedEdgeKey(from, to);
  const roadToRemove = edgeMap.get(normKey);
  if (!roadToRemove) return false;

  // Remove from array by reference (safe even if coords were normalized differently)
  for (let i = 0; i < roads.length; i++) {
    if (roads[i] === roadToRemove) {
      roads.splice(i, 1);
      edgeMap.delete(normKey);
      return true;
    }
  }

  // Map/array desync (should not happen via normal API) — clean map
  edgeMap.delete(normKey);
  return false;
}

/**
 * Returns the Road object for the given edge (either direction) or undefined.
 * O(1) via internal Map. Performs lazy rebuild from the passed `roads` array
 * if the map is empty. When main.js replaces `state.roads` with a new array
 * (load, restart, etc.), it MUST call `invalidateEdgeMap()` first so that
 * the next lookup sees the fresh data.
 * Signature and return value are unchanged.
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {Road|undefined}
 */
export function findRoadBetween(roads, from, to) {
  if (!from || !to || !Array.isArray(roads)) return undefined;
  const normKey = getNormalizedEdgeKey(from, to);

  if (edgeMap.size === 0 && roads.length > 0) {
    rebuildEdgeMap(roads);
  }
  return edgeMap.get(normKey);
}

/**
 * Adds vehicleId to the occupantIds list of the matching edge.
 * Idempotent: does nothing if already present or road missing.
 * Appends to end (travel order is not strictly maintained — see ASSUMPTIONS).
 * @param {Road[]} roads
 * @param {TileCoord} from - vehicle's travel origin tile on this edge
 * @param {TileCoord} to - vehicle's travel destination tile on this edge
 * @param {string} vehicleId
 * @returns {boolean} true if the id was newly added
 */
export function addVehicleToEdge(roads, from, to, vehicleId) {
  const road = findRoadBetween(roads, from, to);
  if (!road) return false;
  if (road.occupantIds.includes(vehicleId)) return false;
  road.occupantIds.push(vehicleId);
  return true;
}

/**
 * Removes vehicleId from the occupantIds list of the matching edge.
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @param {string} vehicleId
 * @returns {boolean} true if the id was found and removed
 */
export function removeVehicleFromEdge(roads, from, to, vehicleId) {
  const road = findRoadBetween(roads, from, to);
  if (!road) return false;
  const idx = road.occupantIds.indexOf(vehicleId);
  if (idx === -1) return false;
  road.occupantIds.splice(idx, 1);
  return true;
}

/**
 * Returns the current occupant count for a road (0 if road is null/undefined).
 * @param {Road|null|undefined} road
 * @returns {number}
 */
export function getOccupancy(road) {
  return road ? road.occupantIds.length : 0;
}

/**
 * Returns speed multiplier in [ROAD_MIN_SPEED_FACTOR, 1.0].
 * Linear interpolation: 0 occupants → 1.0, occupancy ≥ capacity → ROAD_MIN_SPEED_FACTOR.
 * @param {Road|null|undefined} road
 * @returns {number}
 */
export function getSpeedFactor(road) {
  if (!road || road.capacity <= 0) {
    return ROAD_MIN_SPEED_FACTOR;
  }
  const occ = road.occupantIds.length;
  const ratio = Math.min(occ / road.capacity, 1);
  return 1 - ratio * (1 - ROAD_MIN_SPEED_FACTOR);
}

/**
 * Convenience wrapper: occupancy for an edge without separate find call.
 * Now O(1) because findRoadBetween is O(1).
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {number}
 */
export function getOccupancyForEdge(roads, from, to) {
  const road = findRoadBetween(roads, from, to);
  return getOccupancy(road);
}

/**
 * Convenience wrapper: speed factor for an edge (used by pathfinding & render).
 * Now O(1) because findRoadBetween is O(1).
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {number}
 */
export function getSpeedFactorForEdge(roads, from, to) {
  const road = findRoadBetween(roads, from, to);
  return getSpeedFactor(road);
}

/**
 * Clears the internal edgeMap cache.
 * MUST be called by the orchestrator (main.js) immediately after it replaces
 * the roads array reference with a new one — e.g.:
 *   - after `state.roads = loaded.roads` from loadGameState()
 *   - on game restart / new session
 *   - any other direct `roads = [...]` or `roads.length = 0` + repopulate
 *
 * After calling this, the next findRoadBetween / get*ForEdge call will
 * trigger a lazy rebuild from the (new) roads array that is passed in.
 * This is the explicit signal required because the module cannot reliably
 * detect reference changes to the roads array on its own.
 */
export function invalidateEdgeMap() {
  edgeMap.clear();
}
