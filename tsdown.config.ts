import { defineConfig } from "tsdown";

export default defineConfig({
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
});
