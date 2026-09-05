import {
  world,
  system,
  Block,
  BlockPermutation,
  BlockRaycastHit,
  ButtonState,
  Direction,
  EntityComponentTypes,
  EntityEquippableComponent,
  EntityInventoryComponent,
  EquipmentSlot,
  GameMode,
  InputButton,
  InputPermissionCategory,
  Player,
  Vector2,
  Vector3,
} from "@minecraft/server";

/**
 * Free cam V2.
 *
 * The player's body is NOT swapped into Spectator any more. Instead the body
 * stays exactly where the command was run and only the *camera* is detached,
 * using the vanilla "minecraft:free" camera preset driven per tick from the
 * player's raw input (Player.inputInfo). Block interaction is redirected from
 * the (frozen) body to whatever the camera is looking at, within a
 * configurable block reach.
 */

/** Camera preset used for the detached view. */
const FREE_CAMERA_PRESET = "minecraft:free";

export const MIN_BLOCK_REACH = 1;
export const MAX_BLOCK_REACH = 32;
export const DEFAULT_BLOCK_REACH = 8;

/** Camera travel speed, in blocks per tick, at 100% speed. */
const BASE_CAMERA_SPEED = 0.45;
/** Hard cap so a 1000% speed setting stays controllable (and chunk-safe). */
const MAX_CAMERA_SPEED = 4;

/**
 * Sign applied to the lateral component of InputInfo.getMovementVector().
 * Flip to -1 if strafing ever ends up mirrored on a future game build.
 */
const STRAFE_SIGN = 1;

/** How far the body may drift from its origin before we snap it back. */
const BODY_DRIFT_TOLERANCE = 0.05;
/** Minimum ticks between two camera-driven block actions. */
const ACTION_COOLDOWN_TICKS = 4;

const CAMERA_MIN_Y = -128;
const CAMERA_MAX_Y = 512;

/** Ticks between action bar refreshes while free cam is active. */
const HUD_INTERVAL_TICKS = 4;

/**
 * Input categories switched off for the body while free cam runs. Jump and
 * Sneak stay enabled on purpose: they are read back through inputInfo to fly
 * the camera up and down, and any residual body motion they cause is undone
 * by the per-tick snap-back in keepBodyAtOrigin().
 */
const FROZEN_INPUT_CATEGORIES = [
  InputPermissionCategory.LateralMovement,
  InputPermissionCategory.Mount,
];

/** Dynamic properties, so a disconnect mid-freecam can still be undone. */
const DP_ACTIVE = "freecam:active";
const DP_ORIGIN = "freecam:origin";
const DP_YAW = "freecam:yaw";
const DP_PITCH = "freecam:pitch";
const DP_DIMENSION = "freecam:dimension";
const DP_REACH = "freecam:reach";

/** Where the real player was standing when free cam was switched on. */
export interface OriginState {
  location: Vector3;
  rotation: Vector2;
  dimensionId: string;
}

interface FreecamSession {
  player: Player;
  origin: OriginState;
  cameraLocation: Vector3;
  cameraRotation: Vector2;
  lastBreakTick: number;
  lastUseTick: number;
}

const sessions = new Map<string, FreecamSession>();
const blockReachByPlayer = new Map<string, number>();
const cameraSpeedPercentByPlayer = new Map<string, number>();

/* -------------------------------------------------------------------------- */
/* small vector helpers                                                        */
/* -------------------------------------------------------------------------- */

function copyVector3(vector: Vector3): Vector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function copyVector2(vector: Vector2): Vector2 {
  return { x: vector.x, y: vector.y };
}

/** Unit view direction for a Bedrock rotation (x = pitch, y = yaw, degrees). */
function directionFromRotation(rotation: Vector2): Vector3 {
  const pitch = (rotation.x * Math.PI) / 180;
  const yaw = (rotation.y * Math.PI) / 180;
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * cosPitch,
  };
}

/** Unit vector pointing to the player's right for a given yaw, in degrees. */
function rightFromYaw(yawDegrees: number): Vector3 {
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: -Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* -------------------------------------------------------------------------- */
/* block reach + camera speed settings                                         */
/* -------------------------------------------------------------------------- */

export function clampBlockReach(blocks: number): number {
  return clamp(Math.round(blocks), MIN_BLOCK_REACH, MAX_BLOCK_REACH);
}

export function getBlockReach(player: Player): number {
  const cached = blockReachByPlayer.get(player.id);
  if (cached !== undefined) {
    return cached;
  }

  const stored = player.getDynamicProperty(DP_REACH);
  const reach = typeof stored === "number" ? clampBlockReach(stored) : DEFAULT_BLOCK_REACH;
  blockReachByPlayer.set(player.id, reach);
  return reach;
}

/**
 * Stores the player's block reach. Values outside 1-32 are clamped; the value
 * actually applied is returned. Writes a dynamic property, so command handlers
 * must defer this via system.run().
 */
export function setBlockReach(player: Player, blocks: number): number {
  const reach = clampBlockReach(blocks);
  blockReachByPlayer.set(player.id, reach);
  player.setDynamicProperty(DP_REACH, reach);
  return reach;
}

/** Ties the existing /freecam:speed percent to how fast the camera flies. */
export function setCameraSpeedPercent(playerId: string, percent: number): void {
  cameraSpeedPercentByPlayer.set(playerId, percent);
}

function cameraSpeedFor(player: Player): number {
  const percent = cameraSpeedPercentByPlayer.get(player.id) ?? 100;
  return Math.min(MAX_CAMERA_SPEED, BASE_CAMERA_SPEED * (percent / 100));
}

/* -------------------------------------------------------------------------- */
/* session lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export function isFreecamActive(player: Player): boolean {
  return sessions.has(player.id);
}

/** Snapshot of the body position that free cam will return the player to. */
export function getFreecamOrigin(player: Player): OriginState | undefined {
  return sessions.get(player.id)?.origin;
}

export function startFreecam(player: Player): OriginState {
  const existing = sessions.get(player.id);
  if (existing) {
    return existing.origin;
  }

  const rotation = player.getRotation();
  const origin: OriginState = {
    location: copyVector3(player.location),
    rotation: copyVector2(rotation),
    dimensionId: player.dimension.id,
  };

  const session: FreecamSession = {
    player,
    origin,
    cameraLocation: copyVector3(player.getHeadLocation()),
    cameraRotation: copyVector2(rotation),
    lastBreakTick: Number.NEGATIVE_INFINITY,
    lastUseTick: Number.NEGATIVE_INFINITY,
  };

  sessions.set(player.id, session);
  persistOrigin(player, origin);
  freezeBody(player);
  applyCamera(session);
  return origin;
}

/**
 * Ends free cam. Unless `restorePosition` is false (e.g. the player died and
 * has already respawned elsewhere) the body is teleported back to the exact
 * position, rotation and dimension recorded when free cam was switched on.
 */
export function stopFreecam(player: Player, restorePosition = true): OriginState | undefined {
  const session = sessions.get(player.id);
  if (!session) {
    return undefined;
  }

  sessions.delete(player.id);
  releaseBody(player);

  try {
    player.camera.clear();
  } catch {
    // Camera is already gone (player unloading) - nothing to restore.
  }

  if (restorePosition) {
    restoreTo(player, session.origin);
  }

  clearPersistedOrigin(player);
  return session.origin;
}

export function toggleFreecam(player: Player): boolean {
  if (sessions.has(player.id)) {
    stopFreecam(player);
    return false;
  }

  startFreecam(player);
  return true;
}

function freezeBody(player: Player): void {
  for (const category of FROZEN_INPUT_CATEGORIES) {
    try {
      player.inputPermissions.setPermissionCategory(category, false);
    } catch {
      // Category unsupported on this build - the per-tick snap-back covers us.
    }
  }
}

function releaseBody(player: Player): void {
  for (const category of FROZEN_INPUT_CATEGORIES) {
    try {
      player.inputPermissions.setPermissionCategory(category, true);
    } catch {
      // Ignore: nothing was disabled in the first place.
    }
  }
}

function restoreTo(player: Player, origin: OriginState): void {
  try {
    player.clearVelocity();
    player.teleport(origin.location, {
      dimension: world.getDimension(origin.dimensionId),
      rotation: origin.rotation,
      keepVelocity: false,
    });
  } catch {
    // Dimension unavailable: fall back to an in-dimension teleport.
    player.teleport(origin.location, { rotation: origin.rotation, keepVelocity: false });
  }
}

/* -------------------------------------------------------------------------- */
/* persistence across a disconnect                                             */
/* -------------------------------------------------------------------------- */

function persistOrigin(player: Player, origin: OriginState): void {
  player.setDynamicProperty(DP_ACTIVE, true);
  player.setDynamicProperty(DP_ORIGIN, origin.location);
  player.setDynamicProperty(DP_PITCH, origin.rotation.x);
  player.setDynamicProperty(DP_YAW, origin.rotation.y);
  player.setDynamicProperty(DP_DIMENSION, origin.dimensionId);
}

function clearPersistedOrigin(player: Player): void {
  player.setDynamicProperty(DP_ACTIVE, undefined);
  player.setDynamicProperty(DP_ORIGIN, undefined);
  player.setDynamicProperty(DP_PITCH, undefined);
  player.setDynamicProperty(DP_YAW, undefined);
  player.setDynamicProperty(DP_DIMENSION, undefined);
}

function readPersistedOrigin(player: Player): OriginState | undefined {
  if (player.getDynamicProperty(DP_ACTIVE) !== true) {
    return undefined;
  }

  const location = player.getDynamicProperty(DP_ORIGIN);
  const pitch = player.getDynamicProperty(DP_PITCH);
  const yaw = player.getDynamicProperty(DP_YAW);
  const dimensionId = player.getDynamicProperty(DP_DIMENSION);

  if (
    typeof location !== "object" ||
    location === null ||
    typeof pitch !== "number" ||
    typeof yaw !== "number" ||
    typeof dimensionId !== "string"
  ) {
    return undefined;
  }

  return {
    location: copyVector3(location as Vector3),
    rotation: { x: pitch, y: yaw },
    dimensionId,
  };
}

/* -------------------------------------------------------------------------- */
/* per-tick camera update                                                      */
/* -------------------------------------------------------------------------- */

function applyCamera(session: FreecamSession): void {
  session.player.camera.setCamera(FREE_CAMERA_PRESET, {
    location: session.cameraLocation,
    rotation: session.cameraRotation,
  });
}

function readVerticalInput(player: Player): number {
  let vertical = 0;
  try {
    if (player.inputInfo.getButtonState(InputButton.Jump) === ButtonState.Pressed) {
      vertical += 1;
    }
    if (player.inputInfo.getButtonState(InputButton.Sneak) === ButtonState.Pressed) {
      vertical -= 1;
    }
  } catch {
    // Button state unavailable: pitch-and-forward flying still works.
  }
  return vertical;
}

function moveCamera(session: FreecamSession): void {
  const player = session.player;
  const movement = player.inputInfo.getMovementVector();
  const vertical = readVerticalInput(player);

  const forward = directionFromRotation(session.cameraRotation);
  const right = rightFromYaw(session.cameraRotation.y);

  let dx = forward.x * movement.y + right.x * movement.x * STRAFE_SIGN;
  let dy = forward.y * movement.y + vertical;
  let dz = forward.z * movement.y + right.z * movement.x * STRAFE_SIGN;

  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-4) {
    return;
  }

  const speed = cameraSpeedFor(player);
  dx = (dx / length) * speed;
  dy = (dy / length) * speed;
  dz = (dz / length) * speed;

  session.cameraLocation = {
    x: session.cameraLocation.x + dx,
    y: clamp(session.cameraLocation.y + dy, CAMERA_MIN_Y, CAMERA_MAX_Y),
    z: session.cameraLocation.z + dz,
  };
}

/** The camera moved, not the player - put the body back if anything nudged it. */
function keepBodyAtOrigin(session: FreecamSession): void {
  const player = session.player;
  const origin = session.origin;

  if (player.dimension.id !== origin.dimensionId) {
    restoreTo(player, origin);
    return;
  }

  const location = player.location;
  const drift = Math.hypot(
    location.x - origin.location.x,
    location.y - origin.location.y,
    location.z - origin.location.z
  );

  if (drift > BODY_DRIFT_TOLERANCE) {
    player.clearVelocity();
    player.teleport(origin.location, { keepVelocity: false });
  }
}

function updateHud(session: FreecamSession): void {
  const player = session.player;
  const camera = session.cameraLocation;
  const hit = raycastFromCamera(session);
  const target = hit ? hit.block.typeId.replace("minecraft:", "") : "-";

  player.onScreenDisplay.setActionBar(
    `§bFree cam§r §7|§r §f${camera.x.toFixed(1)} ${camera.y.toFixed(1)} ${camera.z.toFixed(1)}§r ` +
      `§7|§r reach §f${getBlockReach(player)}§r §7|§r §f${target}`
  );
}

system.runInterval(() => {
  if (sessions.size === 0) {
    return;
  }

  const tick = system.currentTick;

  for (const [playerId, session] of sessions) {
    if (!session.player.isValid) {
      sessions.delete(playerId);
      continue;
    }

    try {
      session.cameraRotation = copyVector2(session.player.getRotation());
      moveCamera(session);
      applyCamera(session);
      keepBodyAtOrigin(session);
      if (tick % HUD_INTERVAL_TICKS === 0) {
        updateHud(session);
      }
    } catch {
      // A single bad tick (unloaded chunk, player mid-teleport) must not kill
      // the interval for every other player in free cam.
    }
  }
}, 1);

/* -------------------------------------------------------------------------- */
/* block interaction, redirected from the body to the camera                   */
/* -------------------------------------------------------------------------- */

function raycastFromCamera(session: FreecamSession): BlockRaycastHit | undefined {
  const direction = directionFromRotation(session.cameraRotation);
  return session.player.dimension.getBlockFromRay(session.cameraLocation, direction, {
    maxDistance: getBlockReach(session.player),
    includeLiquidBlocks: false,
    includePassableBlocks: false,
  });
}

function blockOnFace(block: Block, face: Direction): Block | undefined {
  switch (face) {
    case Direction.Up:
      return block.above();
    case Direction.Down:
      return block.below();
    case Direction.North:
      return block.north();
    case Direction.South:
      return block.south();
    case Direction.East:
      return block.east();
    case Direction.West:
      return block.west();
    default:
      return undefined;
  }
}

function canEditBlocks(player: Player): boolean {
  const gameMode = player.getGameMode();
  return gameMode === GameMode.Creative || gameMode === GameMode.Survival;
}

function onCooldown(lastTick: number): boolean {
  return system.currentTick - lastTick < ACTION_COOLDOWN_TICKS;
}

function breakFromCamera(player: Player): void {
  const session = sessions.get(player.id);
  if (!session || !player.isValid || onCooldown(session.lastBreakTick) || !canEditBlocks(player)) {
    return;
  }

  const hit = raycastFromCamera(session);
  if (!hit) {
    return;
  }

  const block = hit.block;
  if (block.isAir || block.typeId === "minecraft:bedrock") {
    return;
  }

  session.lastBreakTick = system.currentTick;

  if (player.getGameMode() === GameMode.Creative) {
    block.setType("minecraft:air");
  } else {
    // "destroy" gives the vanilla drops, particles and sound.
    block.dimension.runCommand(`setblock ${block.x} ${block.y} ${block.z} air destroy`);
  }
}

/** Doors, trapdoors and fence gates - the openables we can drive from script. */
function tryToggleOpenable(block: Block): boolean {
  const open = block.permutation.getAllStates()["open_bit"];
  if (typeof open !== "boolean") {
    return false;
  }

  block.setPermutation(block.permutation.withState("open_bit", !open));
  return true;
}

function consumeHeldItem(player: Player): void {
  const inventory = player.getComponent(EntityComponentTypes.Inventory) as
    | EntityInventoryComponent
    | undefined;
  const container = inventory?.container;
  if (!container) {
    return;
  }

  const slot = player.selectedSlotIndex;
  const stack = container.getItem(slot);
  if (!stack) {
    return;
  }

  if (stack.amount > 1) {
    stack.amount -= 1;
    container.setItem(slot, stack);
  } else {
    container.setItem(slot, undefined);
  }
}

function placeFromCamera(player: Player, session: FreecamSession, hit: BlockRaycastHit): void {
  const equippable = player.getComponent(EntityComponentTypes.Equippable) as
    | EntityEquippableComponent
    | undefined;
  const held = equippable?.getEquipment(EquipmentSlot.Mainhand);
  if (!held) {
    return;
  }

  let permutation: BlockPermutation;
  try {
    permutation = BlockPermutation.resolve(held.typeId);
  } catch {
    // Held item is not a placeable block (tool, food, redstone dust, ...).
    return;
  }

  const target = blockOnFace(hit.block, hit.face);
  if (!target || (!target.isAir && !target.isLiquid)) {
    return;
  }

  target.setPermutation(permutation);
  session.lastUseTick = system.currentTick;

  if (player.getGameMode() !== GameMode.Creative) {
    consumeHeldItem(player);
  }
}

function useFromCamera(player: Player): void {
  const session = sessions.get(player.id);
  if (!session || !player.isValid || onCooldown(session.lastUseTick) || !canEditBlocks(player)) {
    return;
  }

  const hit = raycastFromCamera(session);
  if (!hit) {
    return;
  }

  if (tryToggleOpenable(hit.block)) {
    session.lastUseTick = system.currentTick;
    return;
  }

  placeFromCamera(player, session, hit);
}

// Left click. The body is frozen and would otherwise chew through whatever
// happens to be in front of it, so the vanilla break is always cancelled and
// replayed against the camera's target instead.
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (!sessions.has(event.player.id)) {
    return;
  }

  event.cancel = true;
  const player = event.player;
  system.run(() => breakFromCamera(player));
});

// Right click onto a block near the body.
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (!sessions.has(event.player.id)) {
    return;
  }

  event.cancel = true;
  if (!event.isFirstEvent) {
    return;
  }

  const player = event.player;
  system.run(() => useFromCamera(player));
});

// Right click while the body is aiming at nothing.
world.beforeEvents.itemUse.subscribe((event) => {
  if (!sessions.has(event.source.id)) {
    return;
  }

  event.cancel = true;
  const player = event.source;
  system.run(() => useFromCamera(player));
});

// The frozen body should not be poking mobs standing next to it either.
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  if (sessions.has(event.player.id)) {
    event.cancel = true;
  }
});

/* -------------------------------------------------------------------------- */
/* session cleanup                                                             */
/* -------------------------------------------------------------------------- */

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) {
    // Died while flying: drop the camera but leave them at their respawn point.
    if (sessions.has(player.id)) {
      system.run(() => stopFreecam(player, false));
    }
    return;
  }

  // Rejoined after disconnecting mid-freecam: undo the leftover state.
  const origin = readPersistedOrigin(player);
  if (!origin) {
    return;
  }

  system.run(() => {
    try {
      player.camera.clear();
    } catch {
      // Nothing to clear.
    }
    releaseBody(player);
    restoreTo(player, origin);
    clearPersistedOrigin(player);
  });
});

world.afterEvents.playerLeave.subscribe((event) => {
  sessions.delete(event.playerId);
  blockReachByPlayer.delete(event.playerId);
  cameraSpeedPercentByPlayer.delete(event.playerId);
});
