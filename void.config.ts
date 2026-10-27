import { defineConfig } from "void/config";

// Void 会根据代码中的 c.env.DB / KV / STORAGE 推断并自动开通 D1 / KV / R2 绑定。
// 此处声明 Worker 运行时配置与自定义域名。
export default defineConfig({
  worker: {
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
  },
  cloudflare: {
    name: "edgerelay",
    workers_dev: true,
    preview_urls: false,
    routes: [{ pattern: "edgerelay.cnz.indevs.in", custom_domain: true }],
  },
});
