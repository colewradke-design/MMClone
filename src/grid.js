/**
 * src/grid.js
 * Purpose: Tile↔pixel conversion, 8-directional neighbor/edge lookup, geometric validity checks, and bounds enforcement. Engine-agnostic geometry layer only.
 * Expected scale: ~65 LOC. Pure functions + one internal constant. No game state, no road storage, no rendering, no DOM.
 * Imports: ./config.js (GRID_WIDTH, GRID_HEIGHT, TILE_SIZE)
 * Exports: isInBounds, getNeighbors, isValidEdge, pixelToTile, tileToPixelCenter, getTileDistance
 */

import { GRID_WIDTH, GRID_HEIGHT, TILE_SIZE } from './config.js';

/** @typedef {{x: number, y: number}} TileCoord */

// 8-directional deltas (order: NW, N, NE, W, E, SW, S, SE)
const NEIGHBOR_DELTAS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1]
];

/**
 * Returns true if the tile lies inside the grid bounds [0, GRID_WIDTH) × [0, GRID_HEIGHT).
 * @param {TileCoord} tile
 * @returns {boolean}
 */
export function isInBounds(tile) {
  return tile.x >= 0 && tile.x < GRID_WIDTH &&
         tile.y >= 0 && tile.y < GRID_HEIGHT;
}

/**
 * Returns the list of all in-bounds 8-directional neighbor tiles (max 8).
 * @param {TileCoord} tile
 * @returns {TileCoord[]}
 */
export function getNeighbors(tile) {
  const result = [];
  for (const [dx, dy] of NEIGHBOR_DELTAS) {
    const nx = tile.x + dx;
    const ny = tile.y + dy;
    if (nx >= 0 && nx < GRID_WIDTH && ny >= 0 && ny < GRID_HEIGHT) {
      result.push({ x: nx, y: ny });
    }
  }
  return result;
}

/**
 * Returns true if from and to are distinct, adjacent (including diagonally), and both inside bounds.
 * This defines a valid 8-directional road edge geometrically.
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {boolean}
 */
export function isValidEdge(from, to) {
  if (!isInBounds(from) || !isInBounds(to)) return false;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return dx <= 1 && dy <= 1 && (dx + dy > 0);
}

/**
 * Converts pixel coordinates to integer tile coordinates (floor division).
 * Result may be out-of-bounds; caller must call isInBounds() when required.
 * @param {number} px
 * @param {number} py
 * @returns {TileCoord}
 */
export function pixelToTile(px, py) {
  return {
    x: Math.floor(px / TILE_SIZE),
    y: Math.floor(py / TILE_SIZE)
  };
}

/**
 * Returns the pixel coordinates of the exact center of the given tile.
 * @param {TileCoord} tile
 * @returns {{x: number, y: number}}
 */
export function tileToPixelCenter(tile) {
  return {
    x: (tile.x + 0.5) * TILE_SIZE,
    y: (tile.y + 0.5) * TILE_SIZE
  };
}

/**
 * Returns Euclidean distance between two tiles in tile-space units.
 * Orthogonal neighbors = 1.0, diagonal neighbors ≈ 1.414. Used for accurate path costs.
 * @param {TileCoord} a
 * @param {TileCoord} b
 * @returns {number}
 */
export function getTileDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
