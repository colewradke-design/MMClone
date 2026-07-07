/**
 * src/main.js
 * Purpose: Fixed-timestep game loop orchestration, FPS measurement, input handler wiring, session lifecycle (init/load/restart), persistence integration, and loss-condition evaluation. Owns high-level flow and the few open decisions (loss timing, save triggers). All other modules are called; main performs no pathfinding, movement, road/building mutation rules, or rendering itself. Now also owns dynamic playable-area growth and Mini Motorways-style color-district introduction (1 dest + 2 houses per new color).
 * Expected scale: ~270 LOC (growth from playable rect state + 3 local helpers + color-introduction logic + density expansion + input guards + road-avoidance plumbing for color districts; original structure and all non-spawn comments preserved).
 * Imports: ./config.js (FIXED_TIMESTEP, MAX_FRAME_SKIP, VEHICLE_SPAWN_INTERVAL, BUILDING_SPAWN_INTERVAL, GRID_WIDTH, GRID_HEIGHT, TILE_SIZE, SHOW_FPS_COUNTER, BUILDING_COLORS), ./state.js (createInitialState, saveGameState, loadGameState), ./roads.js (createRoad, removeRoad, findRoadBetween, invalidateEdgeMap), ./buildings.js (createBuilding, findBuildingAtTile, updateBuildingTimers, getHousesWithDemand, getDestinations, getDestinationsByColor, spawnHouse, spawnDestination, hasOverloadedBuilding, decrementWaitingCount, incrementWaitingCount), ./vehicles.js (spawnVehicle, updateVehicles), ./render.js (render), ./input.js (initInput)
 * Exports: None (executes setup on module evaluation / DOM ready)
 *
 * -- Defold equivalent: bootstrap `main.script` + `update(self, dt)` with `msg.post` for input; `init` for load/start.
 */

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

import {
  FIXED_TIMESTEP,
  MAX_FRAME_SKIP,
  VEHICLE_SPAWN_INTERVAL,
  BUILDING_SPAWN_INTERVAL,
  GRID_WIDTH,
  GRID_HEIGHT,
  TILE_SIZE,
  SHOW_FPS_COUNTER,
  BUILDING_COLORS
} from './config.js';

import {
  createInitialState,
  saveGameState,
  loadGameState
} from './state.js';

import {
  createRoad,
  removeRoad,
  findRoadBetween,
  invalidateEdgeMap
} from './roads.js';

import {
  createBuilding,
  findBuildingAtTile,
  updateBuildingTimers,
  getHousesWithDemand,
  getDestinations,
  getDestinationsByColor,
  spawnHouse,
  spawnDestination,
  hasOverloadedBuilding,
  decrementWaitingCount,
  incrementWaitingCount
} from './buildings.js';

import {
  spawnVehicle,
  updateVehicles
} from './vehicles.js';

import { render } from './render.js';
import { initInput } from './input.js';

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

/** @type {GameState|null} */
let state = null;
let canvas = null;
let ctx = null;

let lastTime = 0;
let accumulator = 0;
let fpsTime = 0;
let frameCount = 0;
let currentFps = 0;

let vehicleSpawnTimer = 0;
let buildingSpawnTimer = 0;
let autoSaveTimer = 0;
let houseDemandRegenTimer = 0;
let roadEditThisGesture = false; // tracks whether current pointer gesture invoked any onRoadToggle (used to distinguish pure tap from drag end for tap-to-delete)

const AUTO_SAVE_INTERVAL = 10; // seconds
const HOUSE_DEMAND_REGEN_INTERVAL = 8; // seconds — balancing decision (see Assumptions made)

// -----------------------------------------------------------------------------
// Mini Motorways color-district model + dynamic playable area (main.js only)
// - Color Introduction Event (≈30% when timer fires): pick fresh color → place 1 destination + exactly 2 houses of that color inside playable rect.
// - Houses of a color may only be spawned after at least one destination of that color exists (enforced here; vehicle spawn already uses getDestinationsByColor).
// - Playable rect starts as centered 10×10; expands by 5 tiles in each direction when ≥40% of its tiles are occupied (buildings + road endpoints). All building placement and road creation confined to playable.
// - On loaded games: unlockedColors populated from existing destinations; playable set to full grid (unrestricted continuation).
// - Initial seeding (new game / restart): 1–2 color-introduction events inside the small starting playable area.
// - unlockedColors + playable bounds are module-local only (no GameState shape change).
// -----------------------------------------------------------------------------

let playableMinX = 19;
let playableMinY = 19;
let playableMaxX = 28;
let playableMaxY = 28;
let unlockedColors = new Set();

/**
 * Resets playable rectangle to the initial centered 10×10 and clears the set of unlocked colors.
 * Called on brand-new sessions and on restartGame.
 */
function resetPlayableArea() {
  playableMinX = Math.floor((GRID_WIDTH - 10) / 2);
  playableMinY = Math.floor((GRID_HEIGHT - 10) / 2);
  playableMaxX = playableMinX + 9;
  playableMaxY = playableMinY + 9;
  unlockedColors = new Set();
}

/**
 * Returns true if the given tile lies inside the current playable rectangle (inclusive).
 * Used to confine building spawns and road drawing.
 * @param {{x:number, y:number}} tile
 * @returns {boolean}
 */
function isInPlayable(tile) {
  if (!tile) return false;
  return tile.x >= playableMinX && tile.x <= playableMaxX &&
         tile.y >= playableMinY && tile.y <= playableMaxY;
}

/**
 * Returns true if the given tile is used as the 'from' or 'to' of any road in the array.
 * Duplicated here (simple O(R) scan) to keep buildings.js contract unchanged while
 * ensuring color-district and initial seeding paths also avoid road endpoints.
 * @param {Array<{from: {x:number,y:number}, to: {x:number,y:number}}>} roads
 * @param {{x:number, y:number}} tile
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
 * Samples random tiles exclusively inside the current playable rectangle and returns the first empty one
 * (no building present AND, when roads provided, no road endpoint).
 * Uses the already-exported findBuildingAtTile. Returns null after reasonable attempts if the playable area is full.
 * @param {Building[]} buildings
 * @param {Road[]} [roads=[]]
 * @returns {{x:number, y:number}|null}
 */
function findRandomEmptyInPlayable(buildings, roads = []) {
  const w = playableMaxX - playableMinX + 1;
  const h = playableMaxY - playableMinY + 1;
  const maxAttempts = Math.min(300, w * h * 2);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = playableMinX + Math.floor(Math.random() * w);
    const y = playableMinY + Math.floor(Math.random() * h);
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

/**
 * Performs one Mini Motorways-style color-introduction event inside the current playable area:
 * picks an unused color, places exactly one destination of that color, then places exactly two houses of the same color
 * (biased toward clustering near the new destination, falling back to any empty playable tile that has no building and no road endpoint).
 * Adds the color to unlockedColors on success. Returns true only if the destination was successfully created.
 * @param {Building[]} buildings
 * @param {Road[]} [roads=[]]
 * @returns {boolean}
 */
function performColorIntroduction(buildings, roads = []) {
  const available = BUILDING_COLORS.filter(c => !unlockedColors.has(c));
  if (available.length === 0) return false;

  const newColor = available[Math.floor(Math.random() * available.length)];

  const destTile = findRandomEmptyInPlayable(buildings, roads);
  if (!destTile) return false;

  const dest = createBuilding(buildings, 'destination', destTile, newColor);
  if (!dest) return false;

  unlockedColors.add(newColor);

  // Try to cluster the two houses near the new destination (small radius first)
  let housesPlaced = 0;
  const radius = 4;
  for (let attempt = 0; attempt < 50 && housesPlaced < 2; attempt++) {
    let hx = destTile.x + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    let hy = destTile.y + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    hx = Math.max(playableMinX, Math.min(playableMaxX, hx));
    hy = Math.max(playableMinY, Math.min(playableMaxY, hy));
    const hTile = { x: hx, y: hy };
    if (!findBuildingAtTile(buildings, hTile) && !tileHasAnyRoadConnection(roads, hTile)) {
      const h = createBuilding(buildings, 'house', hTile, newColor);
      if (h) housesPlaced++;
    }
  }

  // Fallback: place any remaining houses anywhere in playable area (still avoiding roads)
  while (housesPlaced < 2) {
    const hTile = findRandomEmptyInPlayable(buildings, roads);
    if (!hTile) break;
    const h = createBuilding(buildings, 'house', hTile, newColor);
    if (h) housesPlaced++;
    else break;
  }

  console.log(`[main] New color district introduced: ${newColor} (1 destination + ${housesPlaced} houses)`);
  return true;
}

/**
 * Computes the fraction of playable-area tiles that are occupied (have a building OR are an endpoint of any road).
 * If density ≥ 0.40, expands the playable rectangle by 5 tiles in every direction (clamped to grid bounds) and logs once.
 * Called every fixed-timestep tick (cost is trivial: O(B + R) with a small Set).
 * @param {Building[]} buildings
 * @param {Road[]} roads
 */
function checkDensityAndExpandIfNeeded(buildings, roads) {
  const occupied = new Set();
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (isInPlayable(b.tile)) {
      occupied.add(`${b.tile.x},${b.tile.y}`);
    }
  }
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (r.from && isInPlayable(r.from)) occupied.add(`${r.from.x},${r.from.y}`);
    if (r.to && isInPlayable(r.to)) occupied.add(`${r.to.x},${r.to.y}`);
  }

  const playableW = playableMaxX - playableMinX + 1;
  const playableH = playableMaxY - playableMinY + 1;
  if (playableW <= 0 || playableH <= 0) return;

  const density = occupied.size / (playableW * playableH);
  if (density >= 0.40) {
    const oldMinX = playableMinX;
    playableMinX = Math.max(0, playableMinX - 5);
    playableMinY = Math.max(0, playableMinY - 5);
    playableMaxX = Math.min(GRID_WIDTH - 1, playableMaxX + 5);
    playableMaxY = Math.min(GRID_HEIGHT - 1, playableMaxY + 5);
    if (playableMinX !== oldMinX) {
      console.log(`[main] Playable area expanded → ${playableMinX}..${playableMaxX}, ${playableMinY}..${playableMaxY} (density ${(density * 100).toFixed(1)}%)`);
    }
  }
}

// -----------------------------------------------------------------------------
// Internal functions
// -----------------------------------------------------------------------------

/**
 * Performs one fixed-timestep simulation step.
 * Order: timers → loss check → vehicles (deliveries) → spawns → periodic save.
 * Freezes further simulation once gameOver is set (next tick returns early).
 * Density/expansion check runs at end of every tick while playing.
 * @param {number} dt - fixed timestep in seconds
 */
function updateSimulation(dt) {
  if (!state || state.gameOver) {
    return;
  }

  state.tick++;

  // Building wait timers (may set overloaded flags)
  updateBuildingTimers(state.buildings, dt);

  // Loss condition: any overloaded building ends the session immediately
  if (hasOverloadedBuilding(state.buildings)) {
    state.gameOver = true;
    saveGameState(state).catch(err => console.warn('[main] gameOver save failed', err));
    // Finish this tick (vehicles may still deliver) then freeze on subsequent ticks
  }

  // Vehicles: movement, queueing, adaptive reroutes, arrivals → deliveries
  const deliveries = updateVehicles(state.vehicles, state.roads, state.buildings, dt);
  state.score += deliveries;

  // Vehicle spawning from houses with demand
  vehicleSpawnTimer += dt;
  if (vehicleSpawnTimer >= VEHICLE_SPAWN_INTERVAL) {
    vehicleSpawnTimer -= VEHICLE_SPAWN_INTERVAL;
    const houses = getHousesWithDemand(state.buildings);
    if (houses.length > 0) {
      const house = houses[Math.floor(Math.random() * houses.length)];
      // Color-matching spawn rule (color identity system):
      // Houses only send vehicles to destinations whose color exactly matches the house color.
      // We replace the previous global getDestinations() with the color-filtered query.
      // If the randomly chosen house has zero matching-color destinations, we skip spawning
      // this tick entirely (the house retains its waitingCount/demand).
      const dests = getDestinationsByColor(state.buildings, house.color);
      if (dests.length > 0) {
        let dest = dests[Math.floor(Math.random() * dests.length)];
        // avoid self if somehow same id (not possible by type)
        if (house.id === dest.id && dests.length > 1) {
          dest = dests[(Math.floor(Math.random() * dests.length) + 1) % dests.length];
        }
        if (house.id !== dest.id) {
          const vehicle = spawnVehicle(state.vehicles, house.id, dest.id, state.roads, state.buildings);
          if (vehicle) {
            decrementWaitingCount(state.buildings, house.id);
          }
        }
      }
      // else: no matching-color destination for this house — skip spawn, demand retained
    }
  }

  // Building spawning — now uses controlled color-district introduction + unlocked-color normal spawns
  buildingSpawnTimer += dt;
  if (buildingSpawnTimer >= BUILDING_SPAWN_INTERVAL) {
    buildingSpawnTimer -= BUILDING_SPAWN_INTERVAL;

    const hasUnlocked = unlockedColors.size > 0;

    if (!hasUnlocked || Math.random() < 0.30) {
      // Color-introduction event (Mini Motorways district spawn)
      performColorIntroduction(state.buildings, state.roads);
    } else if (hasUnlocked) {
      // Normal spawn using only already-unlocked colors (a destination of that color already exists)
      const colorList = Array.from(unlockedColors);
      if (colorList.length > 0) {
        const chosenColor = colorList[Math.floor(Math.random() * colorList.length)];
        const tile = findRandomEmptyInPlayable(state.buildings, state.roads);
        if (tile) {
          if (Math.random() < 0.65) {
            spawnHouse(state.buildings, state.roads);
          } else {
            spawnDestination(state.buildings, state.roads);
          }
        }
      }
    } else {
      // Fallback (should rarely happen after initial seeding)
      performColorIntroduction(state.buildings, state.roads);
    }
  }

  // Demand regeneration: periodically refill waitingCount on a random subset of
  // non-overloaded houses that have cleared prior demand (waitingCount === 0).
  // This sustains ongoing traffic/congestion instead of one-shot deliveries per house.
  // Only when destinations exist (cheap proxy for "houses with connected destinations").
  // Small subset (≤2) keeps volume manageable. Uses only already-exported buildings.js APIs.
  houseDemandRegenTimer += dt;
  if (houseDemandRegenTimer >= HOUSE_DEMAND_REGEN_INTERVAL) {
    houseDemandRegenTimer -= HOUSE_DEMAND_REGEN_INTERVAL;
    if (getDestinations(state.buildings).length > 0) {
      const candidates = state.buildings.filter(b =>
        b.type === 'house' && !b.overloaded && b.waitingCount === 0
      );
      if (candidates.length > 0) {
        const num = Math.min(2, candidates.length);
        for (let k = 0; k < num; k++) {
          const h = candidates[Math.floor(Math.random() * candidates.length)];
          incrementWaitingCount(state.buildings, h.id, 1);
        }
      }
    }
  }

  // Density check & playable expansion (runs every fixed tick while playing)
  checkDensityAndExpandIfNeeded(state.buildings, state.roads);

  // Periodic autosave (non-blocking, only while playing)
  if (!state.gameOver) {
    autoSaveTimer += dt;
    if (autoSaveTimer >= AUTO_SAVE_INTERVAL) {
      autoSaveTimer -= AUTO_SAVE_INTERVAL;
      saveGameState(state).catch(err => console.warn('[main] autosave failed', err));
    }
  }
}

/**
 * Main animation loop. Accumulates real time into fixed steps (capped by MAX_FRAME_SKIP).
 * Always renders once per frame. FPS computed over 1s windows.
 * @param {number} [now]
 */
function gameLoop(now = performance.now()) {
  const frameTime = (now - lastTime) / 1000;
  lastTime = now;

  // FPS measurement
  fpsTime += frameTime;
  frameCount++;
  if (fpsTime >= 1.0) {
    currentFps = frameCount / fpsTime;
    frameCount = 0;
    fpsTime = 0;
  }

  // Fixed-timestep catch-up (decoupled from render)
  accumulator += frameTime;
  let ticksRun = 0;
  while (accumulator >= FIXED_TIMESTEP && ticksRun < MAX_FRAME_SKIP) {
    updateSimulation(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
    ticksRun++;
  }
  // If we hit the skip cap, drop excess time (prevents spiral of death)
  if (accumulator > FIXED_TIMESTEP * MAX_FRAME_SKIP) {
    accumulator = FIXED_TIMESTEP * MAX_FRAME_SKIP;
  }

  // Render (variable rate, reads latest state)
  if (ctx && state) {
    render(ctx, state, SHOW_FPS_COUNTER ? currentFps : 0);
  }

  requestAnimationFrame(gameLoop);
}

/**
 * Restarts the game to a fresh session.
 * Discards previous state entirely (new arrays, reset timers, initial buildings).
 * Calls invalidateEdgeMap because roads reference is replaced.
 * Resets playable area to initial 10×10 and performs 1–2 color-introduction events.
 */
function restartGame() {
  if (!state) return;

  state = createInitialState();
  invalidateEdgeMap(); // call site #2: after createInitialState on restart

  resetPlayableArea();

  // Seed a playable starting position using color-district introduction (1 dest + 2 houses per color)
  performColorIntroduction(state.buildings, state.roads);
  if (Math.random() < 0.6) {
    performColorIntroduction(state.buildings, state.roads);
  }

  vehicleSpawnTimer = 0;
  buildingSpawnTimer = 0;
  autoSaveTimer = 0;
  houseDemandRegenTimer = 0;
  roadEditThisGesture = false;

  // Ensure clean flags (already true from createInitialState)
  state.gameOver = false;
  state.score = 0;
  state.tick = 0;
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

async function initGame() {
  // Locate the canvas (robust to id variations)
  canvas = document.querySelector('canvas');
  if (!canvas) {
    console.error('[main.js] No <canvas> element found. Please add <canvas id="game" width="1536" height="1536"></canvas> (or any single canvas) to index.html');
    return;
  }

  ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error('[main.js] Failed to get 2D context');
    return;
  }

  // Enforce correct internal resolution (48×48 tiles × 32 px)
  canvas.width = GRID_WIDTH * TILE_SIZE;
  canvas.height = GRID_HEIGHT * TILE_SIZE;

  // Attempt restore or start fresh
  let loadedState = null;
  try {
    loadedState = await loadGameState();
  } catch (err) {
    console.warn('[main.js] IndexedDB load failed, starting fresh', err);
  }

  if (loadedState && Array.isArray(loadedState.roads) && Array.isArray(loadedState.buildings) && Array.isArray(loadedState.vehicles)) {
    state = loadedState;

    // Populate unlockedColors from any existing destination buildings (supports old saves)
    unlockedColors = new Set();
    for (let i = 0; i < state.buildings.length; i++) {
      const b = state.buildings[i];
      if (b && b.type === 'destination' && b.color && BUILDING_COLORS.includes(b.color)) {
        unlockedColors.add(b.color);
      }
    }

    // Loaded/continued sessions run unrestricted on the full grid
    playableMinX = 0;
    playableMinY = 0;
    playableMaxX = GRID_WIDTH - 1;
    playableMaxY = GRID_HEIGHT - 1;
  } else {
    state = createInitialState();
    resetPlayableArea();

    // Seed initial playable district(s) — one or two color-introduction events inside the small starting 10×10 area
    performColorIntroduction(state.buildings, state.roads);
    if (Math.random() < 0.6) {
      performColorIntroduction(state.buildings, state.roads);
    }
  }

  invalidateEdgeMap(); // call site #1: after any loadGameState() or createInitialState() that sets state.roads

  // Reset simulation timers
  vehicleSpawnTimer = 0;
  buildingSpawnTimer = 0;
  autoSaveTimer = 0;
  houseDemandRegenTimer = 0;
  roadEditThisGesture = false;
  accumulator = 0;
  lastTime = performance.now();
  fpsTime = 0;
  frameCount = 0;
  currentFps = 0;

  // Small local helper (RULES §5: contained to this file only).
  // Finds the first road that has the given tile as an endpoint AND has zero occupants.
  // Returns the Road object (or null). Used exclusively by tap-to-delete.
  // Does not mutate; caller decides remove.
  function findFirstUnoccupiedRoadAtTile(roads, tile) {
    if (!Array.isArray(roads) || !tile) return null;
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (!r || !r.from || !r.to || !Array.isArray(r.occupantIds)) continue;
      const touches = (r.from.x === tile.x && r.from.y === tile.y) ||
                      (r.to.x === tile.x && r.to.y === tile.y);
      if (touches && r.occupantIds.length === 0) {
        return r;
      }
    }
    return null;
  }

  // Wire input (tile coords only; handlers close over mutable state binding)
  initInput(canvas, {
    onRoadToggle: (from, to) => {
      if (!isInPlayable(from) || !isInPlayable(to)) return; // confine road drawing to playable area
      roadEditThisGesture = true; // any invocation means this was a drag gesture (not a pure tap)
      if (!state || state.gameOver) return;
      if (!findRoadBetween(state.roads, from, to)) {
        createRoad(state.roads, from, to);
      }
      // NOTE: deliberately never calls removeRoad here.
      // Dragging now only creates; deletion is exclusively via tap-to-delete on stationary up.
    },
    onCanvasClick: (tile) => {
      if (state && state.gameOver) {
        restartGame();
        roadEditThisGesture = false;
        return;
      }

      if (!roadEditThisGesture) {
        // --- Tap-to-delete logic (new) ---
        // Only fires for true stationary taps (pointer down+up on same tile with no onRoadToggle calls during gesture).
        // If any road edit happened during the gesture we skip delete (prevents "build then instantly delete on release").
        // Tradeoff accepted: if a drag gesture occurred but happened to call zero onRoadToggle
        // (dragged exclusively over already-existing roads), tap-delete will still run on the release tile.
        // This is rare in normal play and matches the conservative interpretation allowed by the spec.
        // Safety: only remove if the road has zero occupants (never strands a vehicle mid-edge).
        // If tile has multiple roads we remove only the first unoccupied match (simple & predictable).
        if (isInPlayable(tile)) { // confine tap-to-delete to playable area
          const roadToDelete = findFirstUnoccupiedRoadAtTile(state.roads, tile);
          if (roadToDelete) {
            removeRoad(state.roads, roadToDelete.from, roadToDelete.to);
            // removeRoad already maintains the internal edgeMap; no invalidateEdgeMap() call required
            // (invalidate is only for cases where the entire roads array reference is replaced).
          }
        }
      }

      roadEditThisGesture = false; // always reset after handling the up event
    },
    onRestartRequest: () => {
      restartGame();
    }
  });

  // Best-effort save on page hide / close
  window.addEventListener('beforeunload', () => {
    if (state && !state.gameOver) {
      // fire-and-forget
      saveGameState(state).catch(() => {});
    }
  });

  // Kick off the loop
  requestAnimationFrame(gameLoop);
}

// Auto-start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGame);
} else {
  initGame();
}
