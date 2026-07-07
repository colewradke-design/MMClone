/**
 * src/vehicles.js
 * Purpose: Object pool for vehicles, spawn/activation with pathfinding, per-timestep movement (congestion speed + same-direction queueing via progress clamp), staggered adaptive rerouting (personality-weighted, with mid-edge progress guard), edge occupancy lifecycle via roads.js API, arrival detection + recycling to pool. Now supports explicit Mini Motorways-style round-trip: outbound house→destination (decrement demand on arrival at dest), then automatic return path to originating house (delivery/score credited only on return arrival at house). Engine-agnostic; reads occupancy/speedFactor but does not duplicate tracking. Vehicles carry optional `color`.
 * Expected scale: ~310 LOC (+~55 LOC for round-trip arrival handler, return path computation on pickup, import updates, JSDoc, and guards). Zero per-frame allocations added.
 * Imports: ./config.js (MAX_VEHICLES, VEHICLE_SPEED, REROUTE_CHECK_INTERVAL, VEHICLE_FOLLOW_DISTANCE, COLORS, COLOR_HEX), ./grid.js (getTileDistance), ./roads.js (addVehicleToEdge, removeVehicleFromEdge, getSpeedFactorForEdge), ./buildings.js (findBuildingById, findBuildingAtTile, decrementWaitingCount), ./pathfinding.js (findPath)
 * Exports: findVehicleById, spawnVehicle, deactivateVehicle, updateVehicles
 *
 * -- Defold equivalent: bootstrap + per-vehicle or manager update(dt) with msg routing for occupancy handoff + round-trip state machine.
 */
// -----------------------------------------------------------------------------
// Imports & module state
// -----------------------------------------------------------------------------
import { MAX_VEHICLES, VEHICLE_SPEED, REROUTE_CHECK_INTERVAL, VEHICLE_FOLLOW_DISTANCE, COLORS, COLOR_HEX } from './config.js';
import { getTileDistance } from './grid.js';
import { addVehicleToEdge, removeVehicleFromEdge, getSpeedFactorForEdge } from './roads.js';
import { findBuildingById, findBuildingAtTile, decrementWaitingCount } from './buildings.js';
import { findPath } from './pathfinding.js';

/** @typedef {{x: number, y: number}} TileCoord */
/** @typedef {{id: string, active: boolean, originId: string|null, destinationId: string|null, path: TileCoord[], pathIndex: number, progress: number, speed: number, personality: number, rerouteTimer: number, color?: string}} Vehicle */

let nextVehicleId = 0;

/**
 * Generates a unique vehicle id (module-scoped counter). Called on every activation/reuse.
 * @returns {string}
 */
function generateVehicleId() {
  const idNum = nextVehicleId++;
  return `v_${idNum.toString().padStart(4, '0')}`;
}

/**
 * Creates a fresh inactive vehicle template (for pool growth).
 * @returns {Vehicle}
 */
function createVehicleTemplate() {
  return {
    id: '',
    active: false,
    originId: null,
    destinationId: null,
    path: [],
    pathIndex: 0,
    progress: 0,
    speed: 0,
    personality: 0.5,
    rerouteTimer: 0,
    color: undefined
  };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Returns a normalized undirected edge key for grouping (smaller tile key first).
 * Used only for queue constraint grouping; does not affect road storage.
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
 * Returns a slightly darker version of the given color.
 * Accepts either a named color key from BUILDING_COLORS (e.g. 'red') — resolved via COLOR_HEX —
 * or a direct #hex string. Simple RGB-based darkening suitable for prototype use.
 * Keeps output as 6-digit #hex. Used to give vehicles a distinct but related shade of their
 * spawning house color so they are visually identifiable by origin district.
 * @param {string} input
 * @param {number} [factor=0.78]
 * @returns {string}
 */
function darkenHexColor(input, factor = 0.78) {
  if (!input || typeof input !== 'string') {
    return COLORS.vehicle || '#2d2d2d';
  }

  let hex = input;
  if (COLOR_HEX && COLOR_HEX[input]) {
    hex = COLOR_HEX[input];
  } else if (!input.startsWith('#')) {
    // Unknown color name (not in COLOR_HEX) — fall back rather than produce garbage
    return COLORS.vehicle || '#2d2d2d';
  }

  let c = hex.startsWith('#') ? hex.slice(1) : hex;
  if (c.length === 3) {
    c = c.split('').map(ch => ch + ch).join('');
  }
  if (c.length !== 6) {
    return COLORS.vehicle || '#2d2d2d';
  }

  const rRaw = parseInt(c.slice(0, 2), 16);
  const gRaw = parseInt(c.slice(2, 4), 16);
  const bRaw = parseInt(c.slice(4, 6), 16);
  if (isNaN(rRaw) || isNaN(gRaw) || isNaN(bRaw)) {
    return COLORS.vehicle || '#2d2d2d';
  }

  const r = Math.max(0, Math.floor(rRaw * factor));
  const g = Math.max(0, Math.floor(gRaw * factor));
  const b = Math.max(0, Math.floor(bRaw * factor));
  return '#' + r.toString(16).padStart(2, '0') +
         g.toString(16).padStart(2, '0') +
         b.toString(16).padStart(2, '0');
}

/**
 * Finds a vehicle by id via linear scan.
 * O(V) acceptable (called on spawn, deactivate, rare events; V<=300).
 * @param {Vehicle[]} vehicles
 * @param {string} id
 * @returns {Vehicle|undefined}
 */
export function findVehicleById(vehicles, id) {
  for (let i = 0; i < vehicles.length; i++) {
    if (vehicles[i].id === id) {
      return vehicles[i];
    }
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Spawns/activates a vehicle from pool (reuses inactive or appends if under MAX_VEHICLES).
 * Computes initial path via findPath; fails (returns null) if no route exists.
 * Adds vehicle to first edge's occupantIds. Caller must decrement house waitingCount (legacy) or manage dest demand.
 * Staggers initial rerouteTimer with random offset.
 * Round-trip contract: vehicle travels house → destination (pickup), decrements demand at destination on arrival,
 * then automatically paths back to the originating house. Delivery credit is given only on return arrival at house.
 * Color behavior unchanged.
 * @param {Vehicle[]} vehicles
 * @param {string} originId
 * @param {string} destinationId
 * @param {Road[]} roads
 * @param {Building[]} buildings
 * @returns {Vehicle|null}
 */
export function spawnVehicle(vehicles, originId, destinationId, roads, buildings) {
  if (!originId || !destinationId || !Array.isArray(roads) || !Array.isArray(buildings)) {
    return null;
  }

  const originB = findBuildingById(buildings, originId);
  const destB = findBuildingById(buildings, destinationId);
  if (!originB || !destB) return null;

  const originTile = { x: originB.tile.x, y: originB.tile.y };
  const destTile = { x: destB.tile.x, y: destB.tile.y };
  if (originTile.x === destTile.x && originTile.y === destTile.y) return null;

  // Determine darkened vehicle color from house color (additive visual identity only)
  let vehicleColor = COLORS.vehicle || '#2d2d2d';
  if (originB.color && typeof originB.color === 'string') {
    vehicleColor = darkenHexColor(originB.color, 0.78);
  }

  // Try to reuse an inactive slot (O(V) scan, but spawn is infrequent ~every 4s)
  let vehicle = null;
  for (let i = 0; i < vehicles.length; i++) {
    if (!vehicles[i].active) {
      vehicle = vehicles[i];
      break;
    }
  }

  if (!vehicle) {
    if (vehicles.length >= MAX_VEHICLES) return null;
    vehicle = createVehicleTemplate();
    vehicles.push(vehicle);
  }

  const personality = Math.random();
  const path = findPath(roads, originTile, destTile, personality);
  if (!path || path.length < 2) {
    return null; // unreachable — do not activate
  }

  // Activate / reset (new id even on reuse to avoid stale references)
  vehicle.id = generateVehicleId();
  vehicle.active = true;
  vehicle.originId = originId;
  vehicle.destinationId = destinationId;
  vehicle.path = path;
  vehicle.pathIndex = 0;
  vehicle.progress = 0;
  vehicle.speed = VEHICLE_SPEED;
  vehicle.personality = personality;
  vehicle.rerouteTimer = Math.random() * REROUTE_CHECK_INTERVAL; // stagger checks
  vehicle.color = vehicleColor; // always set/reset on activation

  // Occupy first edge
  addVehicleToEdge(roads, path[0], path[1], vehicle.id);

  return vehicle;
}

/**
 * Deactivates a vehicle, removes it from any current edge occupancy, clears fields, returns to pool.
 * Safe to call if already inactive. Used by main.js for stranded-vehicle cleanup on road/building removal.
 * Also clears the color field to keep pool objects clean.
 * @param {Vehicle[]} vehicles
 * @param {Road[]} roads
 * @param {string} id
 * @returns {boolean} true if a vehicle was deactivated
 */
export function deactivateVehicle(vehicles, roads, id) {
  const v = findVehicleById(vehicles, id);
  if (!v || !v.active) return false;

  // Remove from current edge if mid-travel
  if (v.path && v.pathIndex < v.path.length - 1) {
    const from = v.path[v.pathIndex];
    const to = v.path[v.pathIndex + 1];
    removeVehicleFromEdge(roads, from, to, v.id);
  }

  v.active = false;
  v.originId = null;
  v.destinationId = null;
  v.path = [];
  v.pathIndex = 0;
  v.progress = 0;
  v.speed = 0;
  v.rerouteTimer = 0;
  v.color = undefined;
  return true;
}

/**
 * Internal helper: handles arrival when a vehicle reaches the final tile of its current path.
 * Implements explicit round-trip:
 *   - If arrived at destination (outbound): decrement its waitingCount (retrieve), then compute + start
 *     return path to originating house (repurposes destinationId to house for reroute/goal tracking).
 *     No delivery credit yet.
 *   - If arrived at house after return leg (destinationId now points to house): credit delivery + deactivate.
 *   - Fallback / legacy one-way: credit + deactivate.
 * Returns number of deliveries credited this call (0 or 1). Mutates vehicle in place.
 * Called from both the "sitting at final" early-out and the edge-transition "reached final this frame" paths.
 * @param {Vehicle} v
 * @param {Vehicle[]} vehicles
 * @param {Road[]} roads
 * @param {Building[]} buildings
 * @returns {number}
 */
function handleVehicleArrival(v, vehicles, roads, buildings) {
  if (!v || !v.active || !v.path || v.path.length === 0) return 0;

  const finalTile = v.path[v.path.length - 1];
  const arrivedB = findBuildingAtTile(buildings, finalTile);
  if (!arrivedB) {
    deactivateVehicle(vehicles, roads, v.id);
    return 1;
  }

  // Outbound pickup at destination
  const isOutboundPickup = (arrivedB.type === 'destination' && arrivedB.id === v.destinationId);
  if (isOutboundPickup) {
    decrementWaitingCount(buildings, arrivedB.id, 1);

    const houseB = v.originId ? findBuildingById(buildings, v.originId) : null;
    if (houseB) {
      const returnPath = findPath(roads, finalTile, houseB.tile, v.personality);
      if (returnPath && returnPath.length >= 2) {
        // Repurpose destinationId to house so reroute + future arrival checks treat house as the goal
        v.destinationId = v.originId;
        v.path = returnPath;
        v.pathIndex = 0;
        v.progress = 0;
        addVehicleToEdge(roads, returnPath[0], returnPath[1], v.id);
        return 0; // credit happens on return arrival at house
      }
    }
    // Could not compute return path — fallback: credit at pickup location and recycle
    deactivateVehicle(vehicles, roads, v.id);
    return 1;
  }

  // Return leg arrival at originating house (we set destinationId = house id on pickup)
  const isReturnToHouse = (arrivedB.type === 'house' && arrivedB.id === v.destinationId);
  if (isReturnToHouse) {
    deactivateVehicle(vehicles, roads, v.id);
    return 1;
  }

  // Legacy one-way or unexpected arrival: credit + recycle
  deactivateVehicle(vehicles, roads, v.id);
  return 1;
}

/**
 * Fixed-timestep vehicle simulation (call from main.js once per FIXED_TIMESTEP).
 * - Staggered reroute checks (personality-weighted findPath from current position)
 * - Congestion speedFactor from roads.js
 * - Per-edge same-direction queueing: groups vehicles, clamps progress behind leader (VEHICLE_FOLLOW_DISTANCE)
 * - Edge transitions: remove from old edge, advance pathIndex, add to new edge, handle arrival (now supports round-trip)
 * - On arrival at destination: retrieve (decrement), auto-path return to house
 * - On arrival back at house: recycle to pool, return +1 delivery count for main.js to apply to score
 * Per-frame complexity: O(V) build groups + O(V) updates + O(V × R) from getSpeedFactorForEdge calls (R = roads.length via internal findRoadBetween linear scan). Reroutes amortized & staggered (guarded on low progress). Round-trip adds one extra findPath + add/remove edge per delivery (amortized, infrequent).
 * -- Defold equivalent: update(dt) on a script/component attached to vehicle instances or a manager
 * @param {Vehicle[]} vehicles
 * @param {Road[]} roads
 * @param {Building[]} buildings
 * @param {number} dt - seconds (FIXED_TIMESTEP)
 * @returns {number} deliveries completed this tick (for score increment in main.js)
 */
export function updateVehicles(vehicles, roads, buildings, dt) {
  if (!dt || dt <= 0 || !Array.isArray(vehicles) || !Array.isArray(roads) || !Array.isArray(buildings)) {
    return 0;
  }

  let deliveredCount = 0;

  // ---------------------------------------------------------------------------
  // 1. Build same-direction edge groups for queueing constraints (O(V))
  //    Only vehicles mid-edge (pathIndex < length-1) participate.
  //    Grouped first by normalized undirected edge, then by exact travel direction.
  // ---------------------------------------------------------------------------
  /** @type {Map<string, Map<string, Array<{v: Vehicle, progress: number}>>>} */
  const edgeGroups = new Map();

  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (!v.active || !v.path || v.pathIndex >= v.path.length - 1) continue;

    const from = v.path[v.pathIndex];
    const to = v.path[v.pathIndex + 1];
    const normKey = getNormalizedEdgeKey(from, to);
    const dirKey = `${from.x},${from.y}>${to.x},${to.y}`;

    if (!edgeGroups.has(normKey)) edgeGroups.set(normKey, new Map());
    const dirMap = edgeGroups.get(normKey);
    if (!dirMap.has(dirKey)) dirMap.set(dirKey, []);
    dirMap.get(dirKey).push({ v, progress: v.progress });
  }

  // Compute max allowed progress per behind vehicle (only groups with 2+ vehicles)
  /** @type {Map<string, number>} id -> maxProgress (clamped behind leader) */
  const maxAllowedProgress = new Map();

  for (const [, dirMap] of edgeGroups) {
    for (const [, list] of dirMap) {
      if (list.length <= 1) continue;
      // Sort descending progress: [0] = front (closest to destination end of edge)
      list.sort((a, b) => b.progress - a.progress);
      for (let j = 1; j < list.length; j++) {
        const allowed = list[j - 1].progress - VEHICLE_FOLLOW_DISTANCE;
        maxAllowedProgress.set(list[j].v.id, allowed);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Per-vehicle update (movement + reroute + edge/arrival handling)
  //    Hot path: O(1) amortized per active vehicle.
  // ---------------------------------------------------------------------------
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (!v.active) continue;

    // --- Reroute check (staggered, only when timer expires) ---
    v.rerouteTimer += dt;
    if (v.rerouteTimer >= REROUTE_CHECK_INTERVAL) {
      v.rerouteTimer = 0;

      const destB = v.destinationId ? findBuildingById(buildings, v.destinationId) : null;
      if (destB && v.path && v.path.length > 0) {
        const currentTile = v.path[Math.min(v.pathIndex, v.path.length - 1)];
        const goalTile = destB.tile;

        if (currentTile.x !== goalTile.x || currentTile.y !== goalTile.y) {
          // Guard against mid-edge reroute jitter: only allow full path reset (pathIndex=0, progress=0)
          // when progress is low (near tile center). Mid-edge (high progress) defers the replan.
          // This keeps render.js linear interpolation smooth; reroute still fires on schedule and
          // succeeds on subsequent checks when vehicle is near a tile (after edge transitions reset progress=0).
          // Threshold chosen conservatively small so any allowed jump is visually negligible.
          // -- Defold equivalent: same guard logic inside vehicle/manager update(dt)
          const onActiveEdge = v.pathIndex < v.path.length - 1;
          if (onActiveEdge && v.progress > 0.12) {
            // defer — current edge occupancy + progress preserved; will retry after full interval
          } else {
            // Remove from current edge to keep occupancy correct before replan
            let wasOnEdge = false;
            let oldFrom = null;
            let oldTo = null;
            if (onActiveEdge) {
              wasOnEdge = true;
              oldFrom = v.path[v.pathIndex];
              oldTo = v.path[v.pathIndex + 1];
              removeVehicleFromEdge(roads, oldFrom, oldTo, v.id);
            }

            const newPath = findPath(roads, currentTile, goalTile, v.personality);
            if (newPath && newPath.length > 0) {
              v.path = newPath;
              v.pathIndex = 0;
              v.progress = 0;
              if (newPath.length > 1) {
                addVehicleToEdge(roads, newPath[0], newPath[1], v.id);
              }
            } else if (wasOnEdge) {
              // No route after congestion change — safest to recycle
              v.active = false;
              v.originId = null;
              v.destinationId = null;
              v.path = [];
              v.pathIndex = 0;
              v.progress = 0;
              v.speed = 0;
              v.color = undefined;
              continue;
            }
          }
        }
      }
    }

    // --- Movement (only if still has an edge to traverse) ---
    if (!v.path || v.path.length === 0 || v.pathIndex >= v.path.length - 1) {
      // Check for arrival at final tile of current leg (handles both outbound pickup and return-to-house)
      if (v.pathIndex >= v.path.length - 1 && v.progress >= 0.999) {
        deliveredCount += handleVehicleArrival(v, vehicles, roads, buildings);
      }
      continue;
    }

    const from = v.path[v.pathIndex];
    const to = v.path[v.pathIndex + 1];

    // Congestion-adjusted speed
    const speedFactor = getSpeedFactorForEdge(roads, from, to);
    const effectiveSpeed = VEHICLE_SPEED * speedFactor;

    // Edge length (orthogonal=1, diagonal≈1.414)
    const edgeLen = getTileDistance(from, to);
    const progressPerSecond = effectiveSpeed / Math.max(edgeLen, 0.001);
    let newProgress = v.progress + progressPerSecond * dt;

    // Apply queueing clamp (if any leader ahead on this exact directed edge)
    const allowed = maxAllowedProgress.get(v.id);
    if (allowed !== undefined) {
      newProgress = Math.min(newProgress, allowed);
    }

    // Clamp to edge bounds
    newProgress = Math.max(0, Math.min(1, newProgress));
    v.progress = newProgress;
    v.speed = effectiveSpeed;

    // Edge transition on completion
    if (v.progress >= 1.0) {
      removeVehicleFromEdge(roads, from, to, v.id);
      v.pathIndex++;
      v.progress = 0;

      if (v.pathIndex < v.path.length - 1) {
        // Enter next edge
        const nextFrom = v.path[v.pathIndex];
        const nextTo = v.path[v.pathIndex + 1];
        addVehicleToEdge(roads, nextFrom, nextTo, v.id);
      } else {
        // Reached final tile this frame — use round-trip aware handler
        deliveredCount += handleVehicleArrival(v, vehicles, roads, buildings);
      }
    }
  }

  return deliveredCount;
}
