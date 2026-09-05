import {
  world,
  system,
  Block,
  BlockPermutation,
  BlockRaycastHit,
  ButtonState,
  Direction,
  EasingType,
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

/**
 * Camera flight uses the same acceleration-and-drag model vanilla creative /
 * spectator flying does, so the camera eases in and coasts out instead of
 * snapping to full speed the moment a key goes down.
 *
 * Terminal speed is ACCELERATION / (1 - DRAG), i.e. 0.45 blocks per tick
 * (9 blocks/s) at 100%, which matches spectator closely.
 */
const MOVE_ACCELERATION = 0.045;
const MOVE_DRAG = 0.9;
/** Below this the camera is treated as stopped, so it settles instead of creeping. */
const MOVE_EPSILON = 0.002;
/** Ceiling on terminal speed regardless of the speed percent, in blocks/tick. */
const MAX_TERMINAL_SPEED = 2.5;

/**
 * Length of the client-side interpolation between two camera updates. The
 * script can only move the camera once per tick (0.05s); easing across exactly
 * that window lets the client draw the in-between frames, which is what turns
 * the 20 Hz stepping into smooth motion.
 */
const CAMERA_EASE_SECONDS = 0.05;

/**
 * Sign applied to the lateral component of InputInfo.getMovementVector().
 * Flip to -1 if strafing ever ends up mirrored on a future game build.
 */
const STRAFE_SIGN = 1;

/** How far the body may drift from its origin before we snap it back. */
const BODY_DRIFT_TOLERANCE = 0.25;
/** The body is frozen by input permissions; this is just a periodic safety net. */
const BODY_CHECK_INTERVAL_TICKS = 10;
/** Minimum ticks between two camera-driven block actions. */
const ACTION_COOLDOWN_TICKS = 4;

const CAMERA_MIN_Y = -128;
const CAMERA_MAX_Y = 512;

/** Ticks between action bar refreshes while free cam is active. */
const HUD_INTERVAL_TICKS = 20;

/**
 * Input categories switched off for the body while free cam runs. The whole
 * Movement category goes, jumping and sneaking included: leaving those enabled
 * meant every tap made the body hop, which then had to be undone by a teleport
 * every single tick. InputInfo still reports the raw button states, so the
 * camera can be flown up and down regardless.
 */
const FROZEN_INPUT_CATEGORIES = [InputPermissionCategory.Movement];

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
  /** Carried between ticks so the camera has spectator-like inertia. */
  velocity: Vector3;
  /** What was last handed to setCamera, so identical updates can be skipped. */
  sentLocation: Vector3;
  sentRotation: Vector2;
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

/** Acceleration for this player, capped so terminal speed stays sane. */
function accelerationFor(player: Player): number {
  const percent = cameraSpeedPercentByPlayer.get(player.id) ?? 100;
  const maxAcceleration = MAX_TERMINAL_SPEED * (1 - MOVE_DRAG);
  return Math.min(maxAcceleration, MOVE_ACCELERATION * (percent / 100));
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

  const head = player.getHeadLocation();
  const session: FreecamSession = {
    player,
    origin,
    cameraLocation: copyVector3(head),
    cameraRotation: copyVector2(rotation),
    velocity: { x: 0, y: 0, z: 0 },
    sentLocation: copyVector3(head),
    sentRotation: copyVector2(rotation),
    lastBreakTick: Number.NEGATIVE_INFINITY,
    lastUseTick: Number.NEGATIVE_INFINITY,
  };

  sessions.set(player.id, session);
  persistOrigin(player, origin);
  freezeBody(player);
  // Forced: the "already sent" snapshot starts equal to the initial pose, so
  // the skip-if-unchanged guard would otherwise swallow the very first update.
  applyCamera(session, true);
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

/**
 * Pushes the camera to the client, easing across one tick so the motion is
 * interpolated instead of stepping at 20 Hz. Identical updates are skipped
 * entirely: a player who is holding still costs no camera traffic at all.
 */
function applyCamera(session: FreecamSession, force = false): void {
  const location = session.cameraLocation;
  const rotation = session.cameraRotation;

  if (
    !force &&
    location.x === session.sentLocation.x &&
    location.y === session.sentLocation.y &&
    location.z === session.sentLocation.z &&
    rotation.x === session.sentRotation.x &&
    rotation.y === session.sentRotation.y
  ) {
    return;
  }

  session.player.camera.setCamera(FREE_CAMERA_PRESET, {
    location,
    rotation,
    easeOptions: { easeTime: CAMERA_EASE_SECONDS, easeType: EasingType.Linear },
  });

  session.sentLocation = copyVector3(location);
  session.sentRotation = copyVector2(rotation);
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

/**
 * Advances the camera one tick using vanilla-style flight physics: the input
 * direction feeds an acceleration, the previous velocity decays by a constant
 * drag, and the sum carries the camera. Vertical input is added on top of the
 * normalised look-direction movement rather than being folded into it, so
 * rising while flying forward does not slow the forward travel - the same way
 * spectator behaves.
 */
function moveCamera(session: FreecamSession): void {
  const player = session.player;
  const movement = player.inputInfo.getMovementVector();
  const vertical = readVerticalInput(player);

  const forward = directionFromRotation(session.cameraRotation);
  const right = rightFromYaw(session.cameraRotation.y);

  let ix = forward.x * movement.y + right.x * movement.x * STRAFE_SIGN;
  let iy = forward.y * movement.y;
  let iz = forward.z * movement.y + right.z * movement.x * STRAFE_SIGN;

  const planar = Math.hypot(ix, iy, iz);
  if (planar > 1) {
    ix /= planar;
    iy /= planar;
    iz /= planar;
  }
  iy += vertical;

  const acceleration = accelerationFor(player);
  const velocity = session.velocity;
  velocity.x = velocity.x * MOVE_DRAG + ix * acceleration;
  velocity.y = velocity.y * MOVE_DRAG + iy * acceleration;
  velocity.z = velocity.z * MOVE_DRAG + iz * acceleration;

  if (Math.abs(velocity.x) < MOVE_EPSILON) velocity.x = 0;
  if (Math.abs(velocity.y) < MOVE_EPSILON) velocity.y = 0;
  if (Math.abs(velocity.z) < MOVE_EPSILON) velocity.z = 0;

  if (velocity.x === 0 && velocity.y === 0 && velocity.z === 0) {
    return;
  }

  session.cameraLocation = {
    x: session.cameraLocation.x + velocity.x,
    y: clamp(session.cameraLocation.y + velocity.y, CAMERA_MIN_Y, CAMERA_MAX_Y),
    z: session.cameraLocation.z + velocity.z,
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

/**
 * Deliberately just a reminder that free cam is on - no coordinates, block ids
 * or reach numbers. The action bar sits under the crosshair while you fly, so
 * anything more than this is clutter.
 */
function updateHud(session: FreecamSession): void {
  session.player.onScreenDisplay.setActionBar("§b● Free cam");
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

      // The body is held in place by input permissions, so this only has to
      // catch the rare outside shove (knockback, explosion, a piston).
      if (tick % BODY_CHECK_INTERVAL_TICKS === 0) {
        keepBodyAtOrigin(session);
      }

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
