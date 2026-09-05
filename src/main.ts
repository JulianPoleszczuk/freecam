import {
  world,
  system,
  Player,
  EntityComponentTypes,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  CustomCommandOrigin,
  CustomCommandResult,
} from "@minecraft/server";

import {
  MAX_BLOCK_REACH,
  MIN_BLOCK_REACH,
  clampBlockReach,
  getBlockReach,
  isFreecamActive,
  setBlockReach,
  setCameraSpeedPercent,
  startFreecam,
  stopFreecam,
  toggleFreecamDebug,
} from "./freecam";

/**
 * NOTE ON COMMAND SYNTAX: The original design called for plain chat commands
 * (e.g. "!freecam") intercepted via world.beforeEvents.chatSend. That event
 * has been removed from the current stable @minecraft/server API surface in
 * favor of the Custom Commands API below, so commands are invoked as
 * slash commands instead: "/freecam:freecam", "/freecam:speed <percent>" and
 * "/freecam:reach <blocks>".
 */

/** Per-player chosen speed percent (1...1000), kept in memory only for V1. */
const speedPercentByPlayer = new Map<string, number>();

const DEFAULT_MOVEMENT_SPEED = 0.1;
const MIN_SPEED_PERCENT = 1;
const MAX_SPEED_PERCENT = 1000;

function getCommandPlayer(origin: CustomCommandOrigin): Player | undefined {
  const source = origin.initiator ?? origin.sourceEntity;
  return source instanceof Player ? source : undefined;
}

function formatLocation(location: { x: number; y: number; z: number }): string {
  return `${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)}`;
}

/**
 * Toggles the detached free cam. The player's body never changes gamemode and
 * never leaves the spot it was standing on - see src/freecam.ts.
 */
function toggleFreecamCommand(player: Player): CustomCommandResult {
  if (isFreecamActive(player)) {
    // Command callbacks run in restricted execution: the teleport and camera
    // reset have to happen on the next system.run() tick.
    system.run(() => {
      const origin = stopFreecam(player);
      if (origin) {
        player.sendMessage(`§7Free cam off - returned to ${formatLocation(origin.location)}.`);
      }
    });
    return { status: CustomCommandStatus.Success, message: "Free cam disabled." };
  }

  const location = player.location;
  system.run(() => startFreecam(player));
  return {
    status: CustomCommandStatus.Success,
    message:
      `Free cam enabled. Your body stays at ${formatLocation(location)}; ` +
      `run the command again to return there. Block reach: ${getBlockReach(player)}.`,
  };
}

function applySpeed(player: Player, percent: number): CustomCommandResult {
  const movement = player.getComponent(EntityComponentTypes.Movement);
  if (!movement) {
    return {
      status: CustomCommandStatus.Failure,
      message: "Could not find movement component on your player.",
    };
  }

  const newSpeed = DEFAULT_MOVEMENT_SPEED * (percent / 100);

  // Validate against the attribute's real bounds synchronously: command
  // callbacks run in restricted execution, so the actual mutation below must
  // be deferred via system.run() and can't have its errors caught here.
  if (newSpeed < movement.effectiveMin || newSpeed > movement.effectiveMax) {
    return {
      status: CustomCommandStatus.Failure,
      message: `Speed ${percent}% is outside the allowed range for this attribute (${movement.effectiveMin}-${movement.effectiveMax}).`,
    };
  }

  system.run(() => movement.setCurrentValue(newSpeed));
  speedPercentByPlayer.set(player.id, percent);
  // The same percent drives how fast the detached camera flies.
  setCameraSpeedPercent(player.id, percent);
  return {
    status: CustomCommandStatus.Success,
    message: `Movement speed set to ${percent}% (${newSpeed.toFixed(4)}).`,
  };
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "freecam:freecam",
      description: "Toggle the detached free camera; your body stays put.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    (origin) => {
      const player = getCommandPlayer(origin);
      if (!player) {
        return { status: CustomCommandStatus.Failure, message: "This command can only be run by a player." };
      }
      return toggleFreecamCommand(player);
    }
  );

  customCommandRegistry.registerCommand(
    {
      name: "freecam:speed",
      description: "Set movement (and free cam) speed as a percent of default (1-1000).",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      mandatoryParameters: [{ name: "percent", type: CustomCommandParamType.Integer }],
    },
    (origin, percent) => {
      const player = getCommandPlayer(origin);
      if (!player) {
        return { status: CustomCommandStatus.Failure, message: "This command can only be run by a player." };
      }

      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return { status: CustomCommandStatus.Failure, message: "Percent must be a valid number." };
      }

      if (percent < MIN_SPEED_PERCENT || percent > MAX_SPEED_PERCENT) {
        return {
          status: CustomCommandStatus.Failure,
          message: `Speed must be between ${MIN_SPEED_PERCENT} and ${MAX_SPEED_PERCENT} percent.`,
        };
      }

      return applySpeed(player, percent);
    }
  );

  customCommandRegistry.registerCommand(
    {
      name: "freecam:reach",
      description: `Set the free cam block interaction reach, in blocks (${MIN_BLOCK_REACH}-${MAX_BLOCK_REACH}).`,
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      mandatoryParameters: [{ name: "blocks", type: CustomCommandParamType.Integer }],
    },
    (origin, blocks) => {
      const player = getCommandPlayer(origin);
      if (!player) {
        return { status: CustomCommandStatus.Failure, message: "This command can only be run by a player." };
      }

      if (typeof blocks !== "number" || !Number.isFinite(blocks)) {
        return { status: CustomCommandStatus.Failure, message: "Reach must be a valid number." };
      }

      if (blocks < MIN_BLOCK_REACH || blocks > MAX_BLOCK_REACH) {
        return {
          status: CustomCommandStatus.Failure,
          message: `Block reach must be between ${MIN_BLOCK_REACH} and ${MAX_BLOCK_REACH} blocks.`,
        };
      }

      const reach = clampBlockReach(blocks);
      // setBlockReach writes a dynamic property, which restricted execution
      // forbids - defer it, but report the already-clamped value now.
      system.run(() => setBlockReach(player, reach));
      return {
        status: CustomCommandStatus.Success,
        message: `Free cam block reach set to ${reach} block${reach === 1 ? "" : "s"}.`,
      };
    }
  );

  customCommandRegistry.registerCommand(
    {
      name: "freecam:debug",
      description: "Toggle the free cam diagnostic read-out on the action bar.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    (origin) => {
      const player = getCommandPlayer(origin);
      if (!player) {
        return { status: CustomCommandStatus.Failure, message: "This command can only be run by a player." };
      }

      const enabled = toggleFreecamDebug(player.id);
      return {
        status: CustomCommandStatus.Success,
        message: enabled
          ? "Free cam debug on. Reads: run = script ticks per second (want 20), " +
            "rot = ticks the game reported a new head rotation (want ~20 while turning), " +
            "cam = camera updates sent, turn = degrees turned."
          : "Free cam debug off.",
      };
    }
  );
});

world.afterEvents.playerLeave.subscribe((event) => {
  speedPercentByPlayer.delete(event.playerId);
});
