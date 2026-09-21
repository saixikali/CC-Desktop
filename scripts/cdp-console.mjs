// 临时诊断：通过 CDP 收集渲染层 console / 异常，并报告 body 文本。
const list = await (await fetch("http://127.0.0.1:9228/json/list")).json();
const page = list.find((t) => t.title === "CC Desktop") ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.consoleAPICalled" || msg.method === "Runtime.exceptionThrown" || msg.method === "Log.entryAdded") {
    console.log("CDP", JSON.stringify(msg.params).slice(0, 800));
  }
  if (msg.id && msg.result?.result?.value) console.log("EVAL", msg.result.result.value);
};
await new Promise((r) => (ws.onopen = r));
send("Runtime.enable");
send("Log.enable");
send("Page.enable");
send("Runtime.evaluate", { expression: "location.reload()", awaitPromise: false });
await new Promise((r) => setTimeout(r, 5000));
send("Runtime.evaluate", {
  expression:
    "JSON.stringify({bg:getComputedStyle(document.body).backgroundColor, root: document.getElementById('root')?.innerText?.slice(0,300)})",
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 1500));
ws.close();
process.exit(0);
