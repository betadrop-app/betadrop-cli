import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { bd: "bin/bd.ts" },
  format: ["esm"],
  target: "node18",
  clean: true,
  // Bake the package version in at build time so the bundle never needs to
  // locate package.json at runtime (which breaks when installed globally).
  define: { __CLI_VERSION__: JSON.stringify(version) },
  // Prepend a shebang so the built file is directly executable as the `bd` binary.
  banner: { js: "#!/usr/bin/env node" },
  // Keep dependencies external — bundling CJS deps (commander, etc.) into a
  // single ESM file breaks their internal require() calls. Node resolves them
  // from node_modules at runtime; npm installs them via package.json deps.
  shims: true,
});
