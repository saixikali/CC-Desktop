// CDP 截图（无视窗口层级/焦点）：node scripts/cdp-shot.mjs <out.png>
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9228/json/list")).json();
const page = list.find((t) => t.title === "CC Desktop") ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(data, "base64"));
console.log("saved", out);
ws.close();
process.exit(0);
