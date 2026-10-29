/**
 * scripts/check-undefined.mjs
 * 服务端代码「未定义标识符」静态体检。
 *
 * 背景：云函数 bundle 由 esbuild 打包，不做类型检查，因此漏写 import 也能构建成功，
 * 但线上运行时会抛 ReferenceError（表现为 /api/admin/actions 返回 500）。
 * 本脚本只关注 TS2304（Cannot find name）与 TS2552（Cannot find name, did you mean），
 * 命中即视为致命问题并中断构建。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let output = "";
try {
  output = execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "-p",
    join(root, "tsconfig.server.json"),
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  // tsc 命中任何错误都会返回非 0，错误内容在 stdout / stderr 中
  output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

const FATAL = /error TS(2304|2552):/;
const fatalLines = output
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => FATAL.test(l));

if (fatalLines.length > 0) {
  console.error("[check-undefined] 检测到未定义标识符（云函数运行时会 500）：");
  for (const line of fatalLines) console.error("  " + line);
  process.exit(1);
}

console.log("[check-undefined] 服务端代码未发现未定义标识符 ✓");