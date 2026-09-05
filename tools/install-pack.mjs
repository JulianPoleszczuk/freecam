import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies BP/ into every Minecraft Bedrock development_behavior_packs folder
 * that actually exists on this machine.
 *
 * There is more than one place Bedrock can live on Windows, and picking the
 * wrong one silently leaves the game running an older build of the pack:
 *
 * - "Minecraft Bedrock" under %APPDATA% is the native build shipped by the
 *   unified Minecraft Launcher. Its packs live under Users\Shared, while each
 *   signed-in account keeps its worlds under Users\<id>.
 * - "Microsoft.MinecraftUWP_..." under %LOCALAPPDATA%\Packages is the older
 *   Store/UWP build.
 * - "Microsoft.MinecraftWindowsBeta_..." is the Preview build.
 */

const PACK_FOLDER_NAME = "FreecamSpeed";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "BP");

const appData = process.env.APPDATA;
const localAppData = process.env.LOCALAPPDATA;

const candidates = [
  appData && join(appData, "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang"),
  localAppData &&
    join(
      localAppData,
      "Packages",
      "Microsoft.MinecraftUWP_8wekyb3d8bbwe",
      "LocalState",
      "games",
      "com.mojang"
    ),
  localAppData &&
    join(
      localAppData,
      "Packages",
      "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe",
      "LocalState",
      "games",
      "com.mojang"
    ),
].filter((path) => typeof path === "string");

if (!existsSync(join(source, "scripts", "main.js"))) {
  console.error("BP/scripts/main.js is missing - run `npm run build` first.");
  process.exit(1);
}

let installed = 0;

for (const comMojang of candidates) {
  const packsDir = join(comMojang, "development_behavior_packs");
  if (!existsSync(packsDir)) {
    continue;
  }

  const destination = join(packsDir, PACK_FOLDER_NAME);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  console.log(`installed -> ${destination}`);
  installed += 1;
}

if (installed === 0) {
  console.error(
    "No Minecraft Bedrock development_behavior_packs folder found. Checked:\n" +
      candidates.map((path) => `  ${path}`).join("\n")
  );
  process.exit(1);
}

console.log(`Done (${installed} location${installed === 1 ? "" : "s"}). Restart the world to reload the script.`);
