/**
 * src/pathfinding.js
 * Purpose: Congestion-aware A* pathfinding on the dynamic road graph. Uses personality (0=shortest distance, 1=prefer high speedFactor edges) to blend edge costs between geometric distance and estimated travel time. Returns tile paths for vehicles.js consumption. Engine-agnostic plain JS, no Canvas/DOM.
 * Expected scale: ~160 LOC. Binary-heap open set for O(log V) extraction; deliberate per-vehicle A* tradeoff vs flow-field (documented below).
 * Imports: ./grid.js (getNeighbors, getTileDistance), ./roads.js (findRoadBetween, getSpeedFactorForEdge)
 * Exports: findPath
 */

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

import { getNeighbors, getTileDistance } from './grid.js';
import { findRoadBetween, getSpeedFactorForEdge } from './roads.js';

/** @typedef {{x: number, y: number}} TileCoord */

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Returns the blended A* edge cost for traveling from→to.
 * cost = (1-p)*dist + p*(dist / speedFactor)
 * When p=0 → pure shortest path (tile distance).
 * When p=1 → pure time-based (prefers uncongested/fast edges).
 * @param {Road[]} roads
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @param {number} personality - [0,1]
 * @returns {number} cost in blended units
 */
function getEdgeCost(roads, from, to, personality) {
  const dist = getTileDistance(from, to);
  // getSpeedFactorForEdge safely returns ROAD_MIN_SPEED_FACTOR if road missing, but caller guards
  const speedFactor = getSpeedFactorForEdge(roads, from, to);
  const timeCost = dist / Math.max(speedFactor, 0.01); // avoid /0
  return (1 - personality) * dist + personality * timeCost;
}

/**
 * Admissible heuristic for A*: straight-line tile distance.
 * Since every blended edgeCost >= dist (because speedFactor <= 1), h = dist is admissible and consistent.
 * @param {TileCoord} a
 * @param {TileCoord} b
 * @returns {number}
 */
function heuristic(a, b) {
  return getTileDistance(a, b);
}

/**
 * Minimal binary min-heap used exclusively for A* open-set key management.
 * Stores tile keys (string). Comparison delegates to external fScore object (live values).
 * Supports duplicate keys (lazy decrease-key strategy) — obsolete higher-f entries are skipped on pop.
 * This is the only change to open-set data structure; cost formula, heuristic and reconstruction are untouched.
 */
class MinHeap {
  constructor(fScoreRef) {
    this.heap = [];           // array of string keys
    this.fScore = fScoreRef;  // live reference — sees updates to fScore[...]
  }

  push(key) {
    this.heap.push(key);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const minKey = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._bubbleDown(0);
    }
    return minKey;
  }

  size() {
    return this.heap.length;
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this._compare(this.heap[idx], this.heap[parentIdx]) < 0) {
        [this.heap[idx], this.heap[parentIdx]] = [this.heap[parentIdx], this.heap[idx]];
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  _bubbleDown(idx) {
    const len = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < len && this._compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < len && this._compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== idx) {
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      } else {
        break;
      }
    }
  }

  _compare(keyA, keyB) {
    const fa = this.fScore[keyA] ?? Infinity;
    const fb = this.fScore[keyB] ?? Infinity;
    return fa - fb;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Computes a path from start tile to goal tile using only existing roads.
 * Uses A* with personality-weighted congestion-aware costs.
 * Returns ordered list of tiles [start, ..., goal] or null if no path exists.
 * Reconstructs path via cameFrom parent pointers.
 * O((V + E) log V) with binary heap + lazy duplicates (duplicates are few in practice on grid graphs).
 * Calls remain infrequent and staggered per vehicle (see vehicles.js + REROUTE_CHECK_INTERVAL).
 * @param {Road[]} roads - current roads array (read-only)
 * @param {TileCoord} start
 * @param {TileCoord} goal
 * @param {number} [personality=0.5]
 * @returns {TileCoord[] | null}
 */
export function findPath(roads, start, goal, personality = 0.5) {
  if (!start || !goal || !Array.isArray(roads)) {
    return null;
  }
  const startKey = `${start.x},${start.y}`;
  const goalKey = `${goal.x},${goal.y}`;
  if (startKey === goalKey) {
    return [{ x: start.x, y: start.y }];
  }

  // Use plain objects for portability (Defold-friendly)
  /** @type {Object.<string, string>} */
  const cameFrom = {};
  /** @type {Object.<string, number>} */
  const gScore = {};
  /** @type {Object.<string, number>} */
  const fScore = {};
  /** @type {Object.<string, boolean>} */
  const closed = {};

  const openHeap = new MinHeap(fScore);

  gScore[startKey] = 0;
  fScore[startKey] = heuristic(start, goal);
  openHeap.push(startKey);

  while (openHeap.size() > 0) {
    const currentKey = openHeap.pop();
    if (!currentKey) break;
    if (closed[currentKey]) continue; // skip stale duplicate entries from lazy updates

    if (currentKey === goalKey) {
      // Reconstruct path
      const path = [];
      let ck = currentKey;
      while (ck !== undefined) {
        const [xStr, yStr] = ck.split(',');
        path.unshift({ x: parseInt(xStr, 10), y: parseInt(yStr, 10) });
        ck = cameFrom[ck];
      }
      return path;
    }

    closed[currentKey] = true;

    // Parse current tile coords
    const [cxStr, cyStr] = currentKey.split(',');
    const current = { x: parseInt(cxStr, 10), y: parseInt(cyStr, 10) };

    const neighbors = getNeighbors(current);
    for (let i = 0; i < neighbors.length; i++) {
      const neigh = neighbors[i];
      const nkey = `${neigh.x},${neigh.y}`;
      if (closed[nkey]) continue;
      // Must have a road edge in either direction
      if (!findRoadBetween(roads, current, neigh)) continue;

      const edgeCost = getEdgeCost(roads, current, neigh, personality);
      const tentativeG = (gScore[currentKey] ?? Infinity) + edgeCost;
      const prevG = gScore[nkey] ?? Infinity;
      if (tentativeG < prevG) {
        cameFrom[nkey] = currentKey;
        gScore[nkey] = tentativeG;
        fScore[nkey] = tentativeG + heuristic(neigh, goal);
        if (!closed[nkey]) {
          openHeap.push(nkey); // allow duplicates for lazy decrease-key; old higher-f entries skipped on pop
        }
      }
    }
  }

  return null; // unreachable
}
