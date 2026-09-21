import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

const alias = {
  "@shared": resolve(rootDir, "src/shared"),
};

const rendererAlias = {
  ...alias,
  "@renderer": resolve(rootDir, "src/renderer/src"),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: {
      __CC_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve(rootDir, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __CC_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(rootDir, "src/preload/index.ts") },
        output: {
          // 沙箱化 preload 使用 CJS 格式（.cjs 适配 package type=module）
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(rootDir, "src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: { alias: rendererAlias },
    define: {
      __CC_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: resolve(rootDir, "out/renderer"),
      rollupOptions: {
        input: { index: resolve(rootDir, "src/renderer/index.html") },
      },
    },
  },
});
