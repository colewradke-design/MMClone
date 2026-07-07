/**
 * src/config.js
 * Purpose: Global constants only. No logic, no side effects. All values are engine-agnostic. Now centralizes BUILDING_COLORS and COLOR_HEX to support building color identity without duplication in other modules.
 * Expected scale: ~40 LOC. Pure named exports for use across modules.
 * Imports: None
 * Exports: GRID_WIDTH, GRID_HEIGHT, TILE_SIZE, MAX_VEHICLES, MAX_BUILDINGS,
 *          FIXED_TIMESTEP, MAX_FRAME_SKIP, PATHFINDING_MS_BUDGET, MAX_TILES_RECOMPUTE,
 *          REROUTE_CHECK_INTERVAL, VEHICLE_SPEED, VEHICLE_SPAWN_INTERVAL,
 *          BUILDING_SPAWN_INTERVAL, ROAD_EDGE_CAPACITY, ROAD_MIN_SPEED_FACTOR,
 *          VEHICLE_FOLLOW_DISTANCE, BUILDING_OVERLOAD_THRESHOLD, COLORS, SHOW_FPS_COUNTER,
 *          BUILDING_COLORS, COLOR_HEX
 */

// Starting state & colors
export const INITIAL_COLORS = 1;
export const STARTING_BUILDINGS = [
  { type: 'house', color: 0 },
  { type: 'dest', color: 0 }
];

// Footprints for grid.js valid-area checks (observed from source: dests need ~6 tiles)
export const DEST_FOOTPRINT = { w: 3, h: 2 };
export const HOUSE_FOOTPRINT = { w: 2, h: 1 };

// Demand & pin generation (pins per second before multiplier)
export const BASE_PIN_RATE = 0.5;
export const OVERLOAD_PIN_THRESHOLD_SQUARE = 7;
export const OVERLOAD_PIN_THRESHOLD_CIRCLE = 10;
export const OVERLOAD_TIMER_MAX = 12; // ticks or seconds equivalent in main loop

// Spawn control (used by buildings.js trySpawn)
export const SPAWN_ATTEMPT_COOLDOWN_TICKS = 120; // ~2 seconds at 60 fps
export const SPAWN_PROBE_ATTEMPTS = 30;          // performance budget for random probes
export const MAX_BUILDINGS_EARLY = 4;            // soft cap that grows via milestones

// Trip-score driven scaling (replaces week mechanic entirely)
export const SCALING_MILESTONES = [20, 80, 200, 450, 900, 1600];
export const DEMAND_RAMP_ON_SPAWN_FAIL = 0.15;   // multiplier boost when no space for new dest
export const DEMAND_MULTIPLIER_STEP = 1.12;      // applied on each crossed milestone

// Future-proof (color & cap growth)
export const MAX_COLORS = 6;
export const MAX_BUILDINGS_LATE = 18;
export const GRID_WIDTH = 48;
export const GRID_HEIGHT = 48;
export const TILE_SIZE = 32;

export const MAX_VEHICLES = 300;
export const MAX_BUILDINGS = 150;

export const FIXED_TIMESTEP = 1 / 60;
export const MAX_FRAME_SKIP = 5;

export const PATHFINDING_MS_BUDGET = 2;
export const MAX_TILES_RECOMPUTE = 500;
export const REROUTE_CHECK_INTERVAL = 1.5; // seconds, per vehicle, staggered

export const VEHICLE_SPEED = 2.5;          // tiles/sec, free-flow (uncongested)
export const VEHICLE_SPAWN_INTERVAL = 4;   // seconds
export const BUILDING_SPAWN_INTERVAL = 15; // seconds

export const ROAD_EDGE_CAPACITY = 3;        // max vehicles queued/traveling per edge at once
export const ROAD_MIN_SPEED_FACTOR = 0.2;   // speed multiplier at full congestion
export const VEHICLE_FOLLOW_DISTANCE = 0.25; // min progress gap behind vehicle ahead, in tile units

export const BUILDING_OVERLOAD_THRESHOLD = 45; // seconds waiting before overload

export const COLORS = {
  background: '#e8e4d8',
  road: '#4a4a4a',
  roadCongested: '#b0392f',
  house: '#5b9bd5',
  destination: '#e07b39',
  vehicle: '#2d2d2d',
  gridLine: '#d4d0c4',
  buildingOverload: '#ff3b30',
};

export const SHOW_FPS_COUNTER = true;

export const BUILDING_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];

export const COLOR_HEX = {
  red: '#e74c3c',
  blue: '#3498db',
  green: '#2ecc71',
  yellow: '#f1c40f',
  purple: '#9b59b6'
};
