# Freecam & Speed (V1)

A minimal Minecraft Bedrock Edition **behavior pack** (no resource pack, no
forms, no icon) built with the `@minecraft/server` Script API. V1 ships two
features:

- **Free cam** - toggles you into Spectator mode (real noclip flying with a
  detached camera) and back to whatever gamemode you were in before.
- **Speed adjustment** - set your movement speed anywhere from 1% to 1000%
  of the vanilla default (`0.1`).

## Important: command syntax differs from a typical "chat command" addon

This pack was originally speced to use plain chat messages like `!freecam`
and `!speed 250`, intercepted via `world.beforeEvents.chatSend`. As of the
current stable `@minecraft/server` (2.9.0), **that event has been removed**
from the API in favor of the newer **Custom Commands** API
(`CustomCommandRegistry`). So instead of chat prefixes, the commands are
real slash commands:

- `/freecam:freecam` - toggle free cam on/off.
- `/freecam:speed <percent>` - set movement speed, `1`-`1000` (percent of
  default). `/freecam:speed 100` resets to vanilla default.

Both commands are registered with `permissionLevel: Any` and
`cheatsRequired: false`, so any player can run them without needing
operator status or cheats enabled - the closest match to the original
"any player can type a quick command" intent.

Feedback for both commands is returned as the command's own result message
(shown in chat), not via `sendMessage`/forms.

## Requirements

- Minecraft Bedrock Edition **1.21.80+** (when the Custom Commands API
  became available).
- **Beta APIs must be enabled** for the world: when creating/editing the
  world, go to *Experiments* and turn on **Beta APIs**. Without this
  toggle, the pack's script will not run at all (scripting add-ons require
  it) and the console will show a script/manifest warning.

## Project layout

```
BP/
  manifest.json         behavior pack manifest
  scripts/main.js        compiled output (gitignored, built from src/)
src/
  main.ts                TypeScript source
package.json
tsconfig.json
esbuild.config.js
```

## Setup

```
npm install
```

## Build

```
npm run build
```

Compiles `src/main.ts` → `BP/scripts/main.js` via esbuild. Use `npm run
watch` during development to rebuild on save.

## Installing into Minecraft

Copy (or symlink) the `BP` folder into your `com.mojang`
`development_behavior_packs` directory, renaming it to something
identifiable (e.g. `FreecamSpeed`).

On Windows, for the Microsoft Store release of Minecraft, that's typically:

```
%LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\development_behavior_packs\
```

(For the Preview build, replace `Microsoft.MinecraftUWP_8wekyb3d8bbwe` with
`Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe`.)

Then, in-game:

1. Create a new world (or edit an existing one).
2. Under **Experiments**, enable **Beta APIs**.
3. Under **Behavior Packs**, activate the pack.
4. Load the world and run `/freecam:freecam` or `/freecam:speed 250`.

## Known limitations (V1)

- Speed and free-cam state are kept in memory only - they are **not**
  reapplied automatically if a player disconnects and rejoins, or respawns.
  `/freecam:speed 100` is always a safe way to reset to vanilla default.
- Free cam is implemented via Spectator mode toggling, not a true detached
  camera with the player's body left in place. A future version could use
  the `minecraft:free` camera preset (`player.camera.setCamera(...)`)
  combined with per-tick `player.inputInfo` reads to move the camera while
  keeping the body stationary - see the comment in `src/main.ts` for the
  extension point.
- If a player disconnects while in free cam, their pre-freecam gamemode
  entry is cleaned up on `playerLeave`; there's no persistence across
  sessions.

## Testing checklist

- Load the world with the pack active and Beta APIs on - no errors should
  appear in the content log.
- `/freecam:freecam` toggles you into spectator and back, restoring your
  original gamemode each time.
- `/freecam:speed 50`, `/freecam:speed 100`, `/freecam:speed 1000` all
  apply proportional speed changes.
- `/freecam:speed 0`, `/freecam:speed 1001`, `/freecam:speed abc`, and
  `/freecam:speed` (no argument) all fail with a clear error message and no
  content log errors.
