import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** 开发代理构造：剥离 Set-Cookie 的 Secure 标记——本地 http 下浏览器会拒收 Secure 会话 Cookie，导致登录后仍无会话 */
function devProxy(target: string) {
  return {
    target,
    changeOrigin: true,
    configure: (proxy: {
      on: (event: string, cb: (proxyRes: { headers: Record<string, string | string[] | undefined> }) => void) => void;
    }) => {
      proxy.on("proxyRes", (proxyRes) => {
        const sc = proxyRes.headers["set-cookie"];
        if (sc) proxyRes.headers["set-cookie"] = (Array.isArray(sc) ? sc : [sc]).map((c) => c.replace(/;\s*Secure/gi, ""));
      });
    },
  };
}

// 构建产物输出到 ../public，随 Worker（Void assets）一起发布到根路径 /
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // EdgeOne 构建容器 fd 上限较低，降低 Rollup 并发读文件数，避免 EMFILE: too many open files
    rollupOptions: { maxParallelFileOps: 4, output: { manualChunks: { vendor: ["react", "react-dom", "react-router-dom"], charts: ["recharts"] } } },
  },
  server: {
    proxy: {
      // 本地开发：前端 HMR + API 代理。默认代理到线上生产（登录会话经代理透传，
      // 同源无跨域问题）；可用 EO_LOCAL_API=http://localhost:8787 指向本地函数运行时。
      // 注意：这是真实生产数据，破坏性操作（删除渠道/账号）会直接生效。
      "/api": devProxy(process.env.EO_LOCAL_API || "https://relay.own.cloudns.nz"),
      "/v1": devProxy(process.env.EO_LOCAL_API || "https://relay.own.cloudns.nz"),
    },
  },
});
