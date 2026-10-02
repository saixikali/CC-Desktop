#!/usr/bin/env node
// 拉取 Live2D 桌宠的第三方运行时（PixiJS 6 / Cubism Core / pixi-live2d-display）与官方免费 Hiyori 示例模型。
// 用法：node fetch-pet-runtime.mjs [目标目录，默认 d:/CC Desktop/pet/live2d]
// 仓库内只保存自研的 4 个源文件（../pet-live2d/），引擎与模型不入库（第三方版权 + 体积），用本脚本可复现。
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.argv[2] || "d:/CC Desktop/pet/live2d";
mkdirSync(join(root, "lib"), { recursive: true });
mkdirSync(join(root, "models"), { recursive: true });

const fetchRetry = async (u, n = 5) => {
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(u);
      if (r.ok) return r;
      console.log("retry", r.status, u);
    } catch (e) {
      console.log("neterr", e.cause?.code || e.message, "attempt", i + 1);
    }
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  return null;
};

// 版本固定（与 2026-10-02 桌宠补丁验证一致）
const libs = [
  ["https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js", "lib/pixi.min.js"],
  ["https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js", "lib/live2dcubismcore.min.js"],
  ["https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js", "lib/cubism4.min.js"]
];
for (const [url, rel] of libs) {
  const r = await fetchRetry(url);
  if (!r) throw new Error("下载失败: " + url);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(root, rel), buf);
  console.log("OK", rel, buf.length);
}

// Hiyori 官方示例模型（Live2D CubismWebSamples，Cubism 4 / model3.json），经 jsDelivr GitHub 镜像
const base = "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Hiyori/";
const rr = await fetchRetry(base + "Hiyori.model3.json");
if (!rr) throw new Error("模型清单下载失败");
const manifest = await rr.json();
mkdirSync(join(root, "models/Hiyori"), { recursive: true });
writeFileSync(join(root, "models/Hiyori/Hiyori.model3.json"), JSON.stringify(manifest, null, 2));
const refs = manifest.FileReferences || {};
const files = [
  refs.Moc,
  ...(refs.Textures || []),
  refs.Physics,
  refs.Pose,
  refs.DisplayInfo,
  ...(refs.Expressions || []).map((e) => e.File),
  ...Object.values(refs.Motions || {}).flat().map((m) => m.File)
].filter(Boolean);
let ok = 0;
for (const f of [...new Set(files)]) {
  const dst = join(root, "models/Hiyori", f);
  mkdirSync(dirname(dst), { recursive: true });
  const x = await fetchRetry(base + f.split("/").map(encodeURIComponent).join("/"));
  if (!x) {
    console.log("SKIP", f);
    continue;
  }
  writeFileSync(dst, Buffer.from(await x.arrayBuffer()));
  ok++;
}
console.log("Hiyori files:", ok);
console.log("完成。自研源文件（index.html/styles.css/renderer.js/preload.cjs）需从仓库 pet-live2d/ 复制到目标目录。");
