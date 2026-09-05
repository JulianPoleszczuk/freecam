# Freecam & Speed (V2)

A minimal Minecraft Bedrock Edition **behavior pack** (no resource pack, no
forms, no icon) built with the `@minecraft/server` Script API.

- **Free cam** - detaches the *camera* only. Your real player keeps standing
  exactly where you switched it on, stays visible in the world, and gets
  teleported back to that exact spot (X/Y/Z, yaw, pitch, dimension) when you
  switch free cam off. The camera flies independently of the body.
- **Block interaction from the camera** - breaking, placing and opening
  doors/trapdoors/fence gates keep working while free cam is active. The
  action is applied to whatever the *camera* is aiming at, not to whatever is
  in front of the frozen body.
- **Block reach** - configurable from **1 to 32** blocks (values above 32 are
  rejected).
- **Speed adjustment** - set your movement speed anywhere from 1% to 1000% of
  the vanilla default (`0.1`). The same percent also scales how fast the free
  cam flies.

## Important: command syntax differs from a typical "chat command" addon

This pack was originally speced to use plain chat messages like `!freecam`
and `!speed 250`, intercepted via `world.beforeEvents.chatSend`. As of the
current stable `@minecraft/server` (2.9.0), **that event has been removed**
from the API in favor of the newer **Custom Commands** API
(`CustomCommandRegistry`). So instead of chat prefixes, the commands are
real slash commands:

- `/freecam:freecam` - toggle free cam on/off.
- `/freecam:speed <percent>` - set movement + camera speed, `1`-`1000`
  (percent of default). `/freecam:speed 100` resets to vanilla default.
- `/freecam:reach <blocks>` - set the free cam block interaction reach,
  `1`-`32`. Defaults to `8` and is remembered per player.

All commands are registered with `permissionLevel: Any` and
`cheatsRequired: false`, so any player can run them without needing operator
status or cheats enabled.

Feedback is returned as the command's own result message (shown in chat), not
via forms.

## How free cam works

Enabling free cam (`/freecam:freecam`):

1. The player's **origin** is snapshotted: X, Y, Z, yaw, pitch and dimension
   id.
2. The gamemode is left completely alone - **no Spectator switching**. The
   body stays in the world at the origin and remains visible to everyone.
3. The camera is detached with the vanilla `minecraft:free` camera preset via
   `player.camera.setCamera(...)`, starting at the player's head.
4. Every tick the script reads the player's raw input
   (`Player.inputInfo.getMovementVector()` plus the Jump/Sneak button states)
   and integrates a camera position of its own, which is pushed back to
   `setCamera`. WASD flies along the camera's view direction, Jump/Sneak fly
   up/down, and looking up/down while moving forward also changes altitude.
5. Movement uses an acceleration-and-drag model
   (`velocity = velocity * 0.65 + input * 0.21`), so the camera eases in and
   coasts to a stop rather than snapping between full speed and standstill.
   Top speed is 12 blocks/s at `/freecam:speed 100` - reached to ~87% within
   a quarter second - and is capped at 50 blocks/s however high the percent
   goes.
6. The whole `Movement` input category is disabled for the body, so it cannot
   walk, jump or sneak at all. A drift check runs twice a second purely as a
   safety net against outside shoves (knockback, an explosion, a piston).

Disabling free cam:

1. The camera is cleared (`player.camera.clear()`).
2. Input permissions are restored.
3. The player is teleported back to the **exact** saved position, rotation
   and dimension - never to wherever the camera happened to be parked.

```
Free cam on:   player = (100, 64, 100)
Camera flies:  (250, 80, -50)
Free cam off:  player = (100, 64, 100)   <- not (250, 80, -50)
```

## Block interaction while free cam is active

The client still raycasts from the body, so the pack intercepts the vanilla
interaction events, **cancels** them (so the frozen body never grief-mines
its own surroundings) and replays the action against a script-side raycast
from the camera:

| Input | Event hooked | What happens |
| --- | --- | --- |
| Left click | `beforeEvents.playerBreakBlock` | Breaks the block the camera is aiming at (within reach). Creative removes it outright; Survival uses `setblock ... destroy` so you get the normal drops, particles and sound. |
| Right click on a block | `beforeEvents.playerInteractWithBlock` | Opens/closes the targeted door, trapdoor or fence gate; otherwise places the held block against the targeted face. |
| Right click at nothing | `beforeEvents.itemUse` | Same as above - this is the path used when the body happens to be aiming at open sky. |

The raycast is limited by the configured block reach
(`/freecam:reach`, 1-32, default 8), so `getBlockFromRay` never returns a
target further away than the setting allows. The action bar shows a plain
`● Free cam` reminder and nothing else - coordinates, block ids and reach
numbers sit right under the crosshair while you fly, so they are left out.

Adventure and Spectator gamemodes are excluded from camera editing, and
interacting with entities is suppressed while free cam is on.

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
  scripts/main.js       compiled output (gitignored, built from src/)
src/
  main.ts               command registration + speed control
  freecam.ts            detached camera, body freezing, camera-based interaction
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

```
npm run deploy
```

Builds the pack and copies `BP/` into every Bedrock
`development_behavior_packs` folder that exists on the machine, as
`FreecamSpeed`. Use this rather than copying by hand - **Windows has more
than one Bedrock data folder**, and installing into the wrong one leaves the
game quietly running an older build of the script:

| Build | Data folder |
| --- | --- |
| Native build from the unified Minecraft Launcher | `%APPDATA%\Minecraft Bedrock\Users\Shared\games\com.mojang\` (worlds live per-account under `Users\<id>\`) |
| Microsoft Store / UWP release | `%LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\` |
| Preview | same as UWP with `Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe` |

If a pack seems not to update, check which of those folders holds a
`development_behavior_packs\FreecamSpeed\manifest.json` and what `version`
it reports. A quick in-game check: `/freecam:reach` only exists from V2
onwards, so if the game does not know that command it is running an old
script.

Note that a behavior pack is only reloaded when the world is loaded - leave
the world and re-enter it (or restart the game) after deploying.

Then, in-game:

1. Create a new world (or edit an existing one).
2. Under **Experiments**, enable **Beta APIs**.
3. Under **Behavior Packs**, activate the pack.
4. Load the world and run `/freecam:freecam`, `/freecam:reach 16` or
   `/freecam:speed 250`.

## Performance notes

The camera is server-driven, so every update is a packet. Three things keep
that cheap:

- `setCamera` is skipped entirely when neither the camera position nor the
  rotation changed since the last tick, so hovering costs nothing.
- Each update eases linearly over exactly one tick (0.05s). Without this the
  view steps at 20 Hz while the game renders far faster, which reads as
  stutter even when the frame rate is fine.
- The body is held still by input permissions instead of by a teleport every
  tick, and the action bar no longer runs a block raycast on a timer.

What the script cannot fix is chunk loading: the camera can fly far past the
chunks the server keeps loaded around your body, and terrain streaming in at
the camera position is the main remaining source of hitching. Flying slower
(`/freecam:speed 50`) or staying nearer the body avoids it.

## Known limitations (V2)

- Placement resolves the held item's id straight to a block permutation, so
  items whose block id differs from the item id (redstone dust, string,
  buckets, seeds, beds in some cases) will not place. Ordinary blocks do.
- Scripted "interaction" covers blocks that expose the `open_bit` state -
  doors, trapdoors, fence gates. Chests, furnaces, crafting tables and
  redstone components cannot be opened from script, so those still need you
  to leave free cam.
- Tool durability is not consumed when breaking from the camera.
- Movement speed is kept in memory only and is **not** reapplied after a
  disconnect or respawn. `/freecam:speed 100` is always a safe reset. Block
  reach *is* persisted per player via a dynamic property.
- If a player disconnects while in free cam, the origin is stored on the
  player as dynamic properties and restored on their next join (camera
  cleared, input permissions restored, teleported back). Dying while in free
  cam ends free cam without teleporting - you keep your respawn point.
- Mojang does not document which way either axis of `getMovementVector()`
  points. The lateral axis turned out to be positive-is-left, so
  `STRAFE_SIGN` in `src/freecam.ts` is `-1`; `FORWARD_SIGN` sits next to it
  for the same reason, should a build ever flip the other axis.
- Looking around carries roughly one to two ticks of latency that spectator
  does not have. The camera rotation has to make a server round trip before
  it can be handed back to `setCamera`, whereas spectator turns client-side.
  Lowering `CAMERA_EASE_SECONDS` to `0` trades the smoothing for a slightly
  more direct feel.

## Testing checklist

- Load the world with the pack active and Beta APIs on - no errors should
  appear in the content log.
- `/freecam:freecam` detaches the camera. Your own body stays visible at the
  spot you were standing on, and your gamemode is unchanged.
- WASD flies the camera; Jump/Sneak move it up/down; the body does not move.
- Fly the camera 100+ blocks away, then `/freecam:freecam` again - you are
  teleported back to the exact coordinates and rotation from step 2.
- `/freecam:reach 1`, `5`, `16`, `32` all apply; `/freecam:reach 0`,
  `/freecam:reach 33` and `/freecam:reach abc` fail with a clear message and
  no content log errors.
- With reach `16`, aim the camera at a block ~10 blocks away and left click:
  that block breaks (not one next to your body). Aim at one ~20 blocks away:
  nothing breaks.
- Right click with a block in hand places it against the camera's target
  face; in Survival the stack shrinks by one.
- `/freecam:speed 50`, `/freecam:speed 100`, `/freecam:speed 1000` all apply
  proportional changes to walking and to free cam fly speed.
- `/freecam:speed 0`, `/freecam:speed 1001`, `/freecam:speed abc`, and
  `/freecam:speed` (no argument) all fail with a clear error message and no
  content log errors.
