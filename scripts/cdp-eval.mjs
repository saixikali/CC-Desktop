// CDP 求值：node scripts/cdp-eval.mjs "<js expression>"
// 在 CC Desktop 页面执行 JS 并打印结果（JSON 序列化）。
const expr = process.argv[2];
if (!expr) {
  console.error("usage: node scripts/cdp-eval.mjs <expr>");
  process.exit(1);
}
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
const res = await send("Runtime.evaluate", {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
});
if (res.exceptionDetails) {
  console.error("EVAL_ERROR", JSON.stringify(res.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(res.result.value, null, 2));
}
ws.close();
process.exit(0);
