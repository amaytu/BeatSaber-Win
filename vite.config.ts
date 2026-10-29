import { defineConfig } from "vite";

// base relativa: o Electron carrega dist/index.html via file://
export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 2000 },
  server: { port: 5199, strictPort: true },
});
