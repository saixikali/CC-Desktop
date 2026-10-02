// CC Desktop 桌宠 preload（文件位于安装目录 pet/ 下，独立 partition，不进 asar）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  getConfig: () => ipcRenderer.invoke("pet:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("pet:set-config", patch),
  listModels: () => ipcRenderer.invoke("pet:list-models"),
  importModel: () => ipcRenderer.invoke("pet:import-model"),
  deleteModel: (id) => ipcRenderer.invoke("pet:delete-model", id),
  openModelsDir: () => ipcRenderer.invoke("pet:open-models-dir"),
  drag: (phase, x, y) => ipcRenderer.invoke("pet:drag", { phase, x, y }),
  setIgnore: (ignore) => ipcRenderer.send("pet:set-ignore", ignore),
  hide: () => ipcRenderer.invoke("pet:hide"),
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:event", handler);
  }
});
