/**
 * scripts/build-assets.mjs
 * 将 public/ 目录下的前端静态产物内嵌为 src/generated-assets.ts，
 * 解决 EdgeOne Makers 云函数模式下静态资源 404 的问题。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

const assets = {};

function scanDir(dir) {
  const files = readdirSync(dir);
  for (const f of files) {
    const full = join(dir, f);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
    } else {
      const rel = relative(publicDir, full).replace(/\\/g, "/");
      const urlPath = "/" + rel;
      const isBinary = f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".ico");
      let type = "text/plain; charset=utf-8";
      if (f.endsWith(".html")) type = "text/html; charset=utf-8";
      else if (f.endsWith(".js")) type = "application/javascript; charset=utf-8";
      else if (f.endsWith(".css")) type = "text/css; charset=utf-8";
      else if (f.endsWith(".png")) type = "image/png";
      else if (f.endsWith(".json")) type = "application/json; charset=utf-8";

      if (isBinary) {
        const buf = readFileSync(full);
        assets[urlPath] = {
          content: buf.toString("base64"),
          isBase64: true,
          type,
        };
      } else {
        const text = readFileSync(full, "utf8");
        assets[urlPath] = {
          content: text,
          isBase64: false,
          type,
        };
      }
    }
  }
}

scanDir(publicDir);

const outContent = `// 由 scripts/build-assets.mjs 自动生成，请勿手动修改
export const EMBEDDED_ASSETS: Record<string, { content: string; isBase64: boolean; type: string }> = ${JSON.stringify(assets, null, 2)};
`;

writeFileSync(join(root, "src", "generated-assets.ts"), outContent, "utf8");
console.log(`[build-assets] 已成功打包 ${Object.keys(assets).length} 个前端静态资产至 src/generated-assets.ts`);
