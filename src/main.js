/**
 * src/main.js
 * Purpose: Fixed-timestep game loop orchestration, FPS measurement, input handler wiring, session lifecycle (init/load/restart), persistence integration, and loss-condition evaluation. Owns high-level flow and the few open decisions (loss timing, save triggers). All other modules are called; main performs no pathfinding, movement, road/building mutation rules, or rendering itself.
 * Expected scale: ~190 LOC. Timing/accumulator logic, spawn orchestration, and lifecycle glue.
 * Imports: ./config.js, ./state.js, ./roads.js, ./buildings.js, ./vehicles.js, ./render.js, ./input.js
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
  SHOW_FPS_COUNTER
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
  updateBuildingTimers,
  getHousesWithDemand,
  getDestinations,
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

const AUTO_SAVE_INTERVAL = 10; // seconds
const HOUSE_DEMAND_REGEN_INTERVAL = 8; // seconds — balancing decision (see Assumptions made)

// -----------------------------------------------------------------------------
// Internal functions
// -----------------------------------------------------------------------------

/**
 * Performs one fixed-timestep simulation step.
 * Order: timers → loss check → vehicles (deliveries) → spawns → periodic save.
 * Freezes further simulation once gameOver is set (next tick returns early).
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
    const dests = getDestinations(state.buildings);
    if (houses.length > 0 && dests.length > 0) {
      const house = houses[Math.floor(Math.random() * houses.length)];
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
  }

  // Building spawning (balanced toward houses)
  buildingSpawnTimer += dt;
  if (buildingSpawnTimer >= BUILDING_SPAWN_INTERVAL) {
    buildingSpawnTimer -= BUILDING_SPAWN_INTERVAL;
    if (Math.random() < 0.65) {
      spawnHouse(state.buildings);
    } else {
      spawnDestination(state.buildings);
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
 */
function restartGame() {
  if (!state) return;

  state = createInitialState();
  invalidateEdgeMap(); // call site #2: after createInitialState on restart

  // Seed a playable starting position
  for (let i = 0; i < 5; i++) {
    spawnHouse(state.buildings);
  }
  for (let i = 0; i < 3; i++) {
    spawnDestination(state.buildings);
  }

  vehicleSpawnTimer = 0;
  buildingSpawnTimer = 0;
  autoSaveTimer = 0;
  houseDemandRegenTimer = 0;

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
  } else {
    state = createInitialState();
    // Seed initial buildings only for brand-new sessions
    for (let i = 0; i < 5; i++) spawnHouse(state.buildings);
    for (let i = 0; i < 3; i++) spawnDestination(state.buildings);
  }

  invalidateEdgeMap(); // call site #1: after any loadGameState() or createInitialState() that sets state.roads

  // Reset simulation timers
  vehicleSpawnTimer = 0;
  buildingSpawnTimer = 0;
  autoSaveTimer = 0;
  houseDemandRegenTimer = 0;
  accumulator = 0;
  lastTime = performance.now();
  fpsTime = 0;
  frameCount = 0;
  currentFps = 0;

  // Wire input (tile coords only; handlers close over mutable state binding)
  initInput(canvas, {
    onRoadToggle: (from, to) => {
      if (!state || state.gameOver) return;
      if (findRoadBetween(state.roads, from, to)) {
        removeRoad(state.roads, from, to);
      } else {
        createRoad(state.roads, from, to);
      }
    },
    onCanvasClick: (tile) => {
      if (state && state.gameOver) {
        restartGame();
      }
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
