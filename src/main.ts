import {
  world,
  system,
  Player,
  GameMode,
  EntityComponentTypes,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  CustomCommandOrigin,
  CustomCommandResult,
} from "@minecraft/server";

/**
 * NOTE ON COMMAND SYNTAX: The original design called for plain chat commands
 * (e.g. "!freecam") intercepted via world.beforeEvents.chatSend. That event
 * has been removed from the current stable @minecraft/server API surface in
 * favor of the Custom Commands API below, so commands are invoked as
 * slash commands instead: "/freecam:freecam" and "/freecam:speed <percent>".
 */

/**
 * Free cam state: maps player id -> gamemode the player was in before
 * the command switched them to Spectator, so we can restore it on toggle-off.
 */
const preFreecamGameMode = new Map<string, GameMode>();

/** Per-player chosen speed percent (1...1000), kept in memory only for V1. */
const speedPercentByPlayer = new Map<string, number>();

const DEFAULT_MOVEMENT_SPEED = 0.1;
const MIN_SPEED_PERCENT = 1;
const MAX_SPEED_PERCENT = 1000;

function getCommandPlayer(origin: CustomCommandOrigin): Player | undefined {
  const source = origin.initiator ?? origin.sourceEntity;
  return source instanceof Player ? source : undefined;
}

function toggleFreecam(player: Player): CustomCommandResult {
  const id = player.id;

  if (player.getGameMode() === GameMode.Spectator && preFreecamGameMode.has(id)) {
    const previousGameMode = preFreecamGameMode.get(id)!;
    preFreecamGameMode.delete(id);
    system.run(() => player.setGameMode(previousGameMode));
    return { status: CustomCommandStatus.Success, message: "Free cam disabled." };
  }

  preFreecamGameMode.set(id, player.getGameMode());
  system.run(() => player.setGameMode(GameMode.Spectator));
  return {
    status: CustomCommandStatus.Success,
    message: "Free cam enabled. Run the command again to return.",
  };

  // V2 extension point: instead of Spectator mode, use the "minecraft:free"
  // camera preset via player.camera.setCamera("minecraft:free", { ... }) combined
  // with per-tick reads of player.inputInfo button states to move the camera
  // while leaving the player's body in place at its current location.
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
  return {
    status: CustomCommandStatus.Success,
    message: `Movement speed set to ${percent}% (${newSpeed.toFixed(4)}).`,
  };
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "freecam:freecam",
      description: "Toggle free camera (spectator) mode.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    (origin) => {
      const player = getCommandPlayer(origin);
      if (!player) {
        return { status: CustomCommandStatus.Failure, message: "This command can only be run by a player." };
      }
      return toggleFreecam(player);
    }
  );

  customCommandRegistry.registerCommand(
    {
      name: "freecam:speed",
      description: "Set movement speed as a percent of default (1-1000).",
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
});

world.afterEvents.playerLeave.subscribe((event) => {
  preFreecamGameMode.delete(event.playerId);
  speedPercentByPlayer.delete(event.playerId);
});
