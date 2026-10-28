/**
 * scripts/build-bundle.mjs
 * 使用 esbuild 打包云函数 bundle 到 cloud-functions/[[default]].js
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "cloud-functions");
mkdirSync(outDir, { recursive: true });

console.log("[build-bundle] 开始编译 EdgeOne 云函数 bundle...");

const result = await esbuild.build({
  entryPoints: [join(root, "src", "edgeone-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@edgeone/pages-blob"],
  outfile: join(outDir, "[[default]].js"),
  logLevel: "warning",
  sourcemap: false,
  minify: true,
});

const bundleSize = readFileSync(join(outDir, "[[default]].js")).length;
console.log(`[build-bundle] 编译完成！产物路径: cloud-functions/[[default]].js (大小: ${(bundleSize / 1024).toFixed(1)} KiB)`);
