import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  server: { proxy: { "/api": "http://localhost:8787", "/v1": "http://localhost:8787" } },
});
