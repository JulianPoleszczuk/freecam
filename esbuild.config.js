import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "BP/scripts/main.js",
  bundle: true,
  format: "esm",
  target: "es2020",
  external: ["@minecraft/server", "@minecraft/server-ui"],
  sourcemap: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(options);
}
