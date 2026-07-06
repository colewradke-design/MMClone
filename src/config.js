/**
 * src/config.js
 * Purpose: Global constants only. No logic, no side effects. All values are engine-agnostic.
 * Expected scale: ~35 LOC. Pure named exports for use across modules.
 * Imports: None
 * Exports: GRID_WIDTH, GRID_HEIGHT, TILE_SIZE, MAX_VEHICLES, MAX_BUILDINGS,
 *          FIXED_TIMESTEP, MAX_FRAME_SKIP, PATHFINDING_MS_BUDGET, MAX_TILES_RECOMPUTE,
 *          REROUTE_CHECK_INTERVAL, VEHICLE_SPEED, VEHICLE_SPAWN_INTERVAL,
 *          BUILDING_SPAWN_INTERVAL, ROAD_EDGE_CAPACITY, ROAD_MIN_SPEED_FACTOR,
 *          VEHICLE_FOLLOW_DISTANCE, BUILDING_OVERLOAD_THRESHOLD, COLORS, SHOW_FPS_COUNTER
 */

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
