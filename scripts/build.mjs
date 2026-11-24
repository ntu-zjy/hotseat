// 打包成单个文件 dist/hotseat.mjs（PRD §9：单一可执行程序）。
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  outfile: "dist/hotseat.mjs",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hotseatRequire } from 'node:module';\nconst require = __hotseatRequire(import.meta.url);",
  },
  define: { __HOTSEAT_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`dist/hotseat.mjs (${pkg.version})`);
