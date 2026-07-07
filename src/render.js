/**
 * src/render.js
 * Purpose: Canvas2D rendering of game state (grid, roads with congestion coloring, buildings with overload state, vehicles positioned via progress interpolation with simple car shape now using per-vehicle `color` (darkened house color) with fallback to COLORS.vehicle, score/FPS/game-over UI). Only module allowed to call Canvas APIs. Reads state + query helpers; no mutations or game logic.
 * Expected scale: ~138 LOC (+3 LOC for color fallback in drawVehicle). O(R+B+V) per frame explicitly flagged.
 * Imports: ./config.js (COLORS, TILE_SIZE, GRID_WIDTH, GRID_HEIGHT, SHOW_FPS_COUNTER, COLOR_HEX), ./roads.js (getSpeedFactor)
 * Exports: render
 *
 * Per-frame complexity: O(R + B + V) — single pass over roads (~<400), buildings (<150), active vehicles (<300). All operations constant time per entity. ZERO hidden allocations in the render loop (module-scoped scratch objects + inlined interpolation replace all tileToPixelCenter calls and position returns). Acceptable well under 16ms budget even at 60fps.
 * -- Defold equivalent: `draw()` lifecycle or `on_render` callback using `draw.*` primitives on a gui/script
 */
// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------
import { COLORS, TILE_SIZE, GRID_WIDTH, GRID_HEIGHT, SHOW_FPS_COUNTER, COLOR_HEX } from './config.js';
import { getSpeedFactor } from './roads.js';
/** @typedef {{x: number, y: number}} TileCoord */
/** @typedef {{id: string, from: TileCoord, to: TileCoord, capacity: number, occupantIds: string[]}} Road */
/** @typedef {{id: string, type: 'house'|'destination', tile: TileCoord, waitingCount: number, waitTimer: number, overloaded: boolean, color?: 'red'|'blue'|'green'|'yellow'|'purple'}} Building */
/** @typedef {{id: string, active: boolean, originId: string|null, destinationId: string|null, path: TileCoord[], pathIndex: number, progress: number, speed: number, personality: number, rerouteTimer: number, color?: string}} Vehicle */
// -----------------------------------------------------------------------------
// Allocation-free scratch objects (RULES.md §11 compliance)
// Reused across all draw calls. Safe because usage is synchronous and immediate
// (compute → draw with values → next iteration overwrites).
// -----------------------------------------------------------------------------
const _p1 = { x: 0, y: 0 };
const _p2 = { x: 0, y: 0 };
/**
 * Writes the pixel center of a tile into the provided output object.
 * Duplicates the math from grid.js only inside render.js (allowed per RULES §11)
 * to eliminate per-frame allocations without changing grid.js contract.
 * @param {TileCoord} tile
 * @param {{x:number, y:number}} out
 * @returns {{x:number, y:number}} the same out object for convenience
 */
function writeTileCenter(tile, out) {
  out.x = (tile.x + 0.5) * TILE_SIZE;
  out.y = (tile.y + 0.5) * TILE_SIZE;
  return out;
}
// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------
/**
 * Draws faint grid lines for tile boundaries.
 * @param {CanvasRenderingContext2D} ctx
 */
function drawGridLines(ctx) {
  const gridPixelWidth = GRID_WIDTH * TILE_SIZE;
  const gridPixelHeight = GRID_HEIGHT * TILE_SIZE;
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 1;
  // Vertical
  for (let x = 0; x <= GRID_WIDTH; x++) {
    const px = x * TILE_SIZE;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, gridPixelHeight);
    ctx.stroke();
  }
  // Horizontal
  for (let y = 0; y <= GRID_HEIGHT; y++) {
    const py = y * TILE_SIZE;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(gridPixelWidth, py);
    ctx.stroke();
  }
}
/**
 * Draws all roads with color indicating congestion level.
 * Uses scratch objects — zero allocations.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Road[]} roads
 */
function drawRoads(ctx, roads) {
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const speedFactor = getSpeedFactor(road);
    ctx.strokeStyle = (speedFactor < 0.5) ? COLORS.roadCongested : COLORS.road;
    writeTileCenter(road.from, _p1);
    writeTileCenter(road.to, _p2);
    ctx.beginPath();
    ctx.moveTo(_p1.x, _p1.y);
    ctx.lineTo(_p2.x, _p2.y);
    ctx.stroke();
  }
}
/**
 * Draws a single building (circle for house, square for destination). Overloaded = red fill.
 * Optionally draws waitingCount text on houses. Uses scratch object.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Building} building
 */
function drawBuilding(ctx, building) {
  writeTileCenter(building.tile, _p1);
  const center = _p1;
  const isOver = building.overloaded;
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 2;
  // Color selection: overloaded buildings always use red (COLORS.buildingOverload).
  // Otherwise use the building's assigned color via COLOR_HEX (from config.js).
  // Defensive fallback to legacy COLORS if color field missing (should not happen for new buildings).
  let fillColor;
  if (isOver) {
    fillColor = COLORS.buildingOverload;
  } else if (building.color && COLOR_HEX[building.color]) {
    fillColor = COLOR_HEX[building.color];
  } else {
    fillColor = (building.type === 'house') ? COLORS.house : COLORS.destination;
  }
  if (building.type === 'house') {
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (building.waitingCount > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(building.waitingCount), center.x, center.y + 1);
    }
  } else {
    // destination
    ctx.fillStyle = fillColor;
    const s = 18;
    ctx.fillRect(center.x - s/2, center.y - s/2, s, s);
    ctx.strokeRect(center.x - s/2, center.y - s/2, s, s);
  }
}
/**
 * Draws all buildings.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Building[]} buildings
 */
function drawBuildings(ctx, buildings) {
  for (let i = 0; i < buildings.length; i++) {
    drawBuilding(ctx, buildings[i]);
  }
}
/**
 * Draws a vehicle as a simple oriented car shape (rect) when on an edge; circle if at final tile.
 * All pixel math uses scratch objects + inlined interpolation. Zero allocations.
 * Computes p1/p2 once and reuses for both position lerp and angle (addresses double-call concern).
 * Vehicle body now uses vehicle.color (darkened house color) when present, with fallback to COLORS.vehicle.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Vehicle} vehicle
 */
function drawVehicle(ctx, vehicle) {
  if (!vehicle.active || !vehicle.path || vehicle.path.length === 0) return;
  if (vehicle.pathIndex >= vehicle.path.length - 1) {
    // arrived / final tile — simple dot (reuse scratch)
    writeTileCenter(vehicle.path[vehicle.path.length - 1], _p1);
    ctx.fillStyle = vehicle.color || COLORS.vehicle;
    ctx.beginPath();
    ctx.arc(_p1.x, _p1.y, 5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // On edge — compute centers once into scratches, lerp position, reuse for angle
  const fromTile = vehicle.path[vehicle.pathIndex];
  const toTile = vehicle.path[vehicle.pathIndex + 1];
  writeTileCenter(fromTile, _p1);
  writeTileCenter(toTile, _p2);
  const t = Math.max(0, Math.min(1, vehicle.progress));
  const posX = _p1.x + (_p2.x - _p1.x) * t;
  const posY = _p1.y + (_p2.y - _p1.y) * t;
  ctx.save();
  ctx.translate(posX, posY);
  const angle = Math.atan2(_p2.y - _p1.y, _p2.x - _p1.x);
  ctx.rotate(angle);
  // Car body (now uses per-vehicle color when available)
  ctx.fillStyle = vehicle.color || COLORS.vehicle;
  ctx.fillRect(-7, -3.5, 14, 7);
  // Front windshield accent
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(1, -2.5, 5, 5);
  ctx.restore();
}
/**
 * Draws all active vehicles.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Vehicle[]} vehicles
 */
function drawVehicles(ctx, vehicles) {
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (v.active) {
      drawVehicle(ctx, v);
    }
  }
}
/**
 * Draws score, optional FPS counter, and game-over overlay.
 * @param {CanvasRenderingContext2D} ctx
 * @param {GameState} state
 * @param {number} fps
 */
function drawUI(ctx, state, fps) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  // Score (top left)
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Score: ${state.score}`, 12, 10);
  // FPS (top right) — explicit textBaseline for robustness (no longer relies on score's setting)
  if (SHOW_FPS_COUNTER && typeof fps === 'number' && fps > 0) {
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#111111';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(fps)} FPS`, W - 10, 10);
  }
  // Game over overlay
  if (state.gameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GAME OVER', W / 2, H / 2 - 30);
    ctx.font = '24px sans-serif';
    ctx.fillText(`Final Score: ${state.score}`, W / 2, H / 2 + 25);
    ctx.font = '16px sans-serif';
    ctx.fillText('Roads & buildings persist — restart via input', W / 2, H / 2 + 70);
  }
}
// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
/**
 * Main render entry point. Clears background, draws grid/roads/buildings/vehicles/UI in order.
 * Must be called every animation frame from main.js (decoupled from fixed sim tick).
 * @param {CanvasRenderingContext2D} ctx - 2D context of the game canvas
 * @param {GameState} state - current full game state (roads, buildings, vehicles, score, gameOver)
 * @param {number} [fps=0] - current FPS for counter (optional)
 */
export function render(ctx, state, fps = 0) {
  if (!ctx || !state) return;
  // 1. Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // 2. Grid lines (under roads)
  drawGridLines(ctx);
  // 3. Roads (colored by current congestion)
  if (Array.isArray(state.roads)) {
    drawRoads(ctx, state.roads);
  }
  // 4. Buildings (on top of road ends)
  if (Array.isArray(state.buildings)) {
    drawBuildings(ctx, state.buildings);
  }
  // 5. Vehicles (on top of roads) — now respect per-vehicle color when present
  if (Array.isArray(state.vehicles)) {
    drawVehicles(ctx, state.vehicles);
  }
  // 6. UI overlays (score, fps, game over)
  drawUI(ctx, state, fps);
}
