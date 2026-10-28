/**
 * scripts/build-bundle.mjs
 * 使用 esbuild 打包云函数 bundle 到 cloud-functions/[[default]].js，
 * 并在 .edgeone/routes.json 中强制注入 ap-tokyo 节点与 120s 超时配置。
 */
import { mkdirSync, readFileSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "cloud-functions");
const distDir = join(root, "dist");
const publicDir = join(root, "public");
const eoDir = join(root, ".edgeone");

mkdirSync(outDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(eoDir, { recursive: true });

console.log("[build-bundle] 开始编译 EdgeOne 云函数 bundle...");

await esbuild.build({
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

// 1. 同步静态资产到 dist/，兼容 EdgeOne 控制台默认的 dist 输出目录
// 根 index.html 必须排除：否则 EdgeOne 的 filesystem 规则会优先命中静态文件，
// 绕过函数里的动态 SEO 渲染，导致首页先闪一下默认站点名再被前端改写。
try {
  cpSync(publicDir, distDir, { recursive: true });
  rmSync(join(distDir, "index.html"), { force: true });
  console.log(`[build-bundle] 已同步静态资产至 dist/ 目录（根 index.html 交给函数动态渲染）`);
} catch (e) {
  // ignore
}

// 2. 关键：强制生成 .edgeone/routes.json，在 conf 块中写入 ap-tokyo 与 maxDuration: 120
// 这是 EdgeOne 底层部署器解析节点调度与超时策略的最高优先级来源
const routesConfig = {
  version: 3,
  routes: [
    { src: "^/$", "server-name": "api-node" },
    { handle: "filesystem" },
    { src: "^/(.*)$", "server-name": "api-node" },
  ],
  conf: {
    cloudFunctions: {
      maxDuration: 120,
      regions: {
        overseas: ["ap-tokyo"],
      },
    },
  },
};

writeFileSync(join(eoDir, "routes.json"), JSON.stringify(routesConfig, null, 2), "utf8");
console.log(`[build-bundle] 已生成 .edgeone/routes.json，锁定 ap-tokyo 节点与 120s 超时`);
