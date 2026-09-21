import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./lib/theme.ts";
import "./styles.css";

// React 挂载前应用缓存主题，避免首帧闪烁。
initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
