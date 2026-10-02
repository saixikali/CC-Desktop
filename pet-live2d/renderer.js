/* CC Desktop 桌宠渲染层（位于安装目录 pet/live2d/ 下，独立 partition，不进 asar） */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage");
  const canvasWrap = $("#canvas-wrap");
  const canvas = $("#pet-canvas");
  const bubbleEl = $("#bubble");
  const bubbleText = $("#bubble-text");
  const gear = $("#gear");
  const ctxMenu = $("#ctx-menu");
  const panel = $("#panel");

  let cfg = null;
  let models = [];
  let model = null;
  let app = null;
  let motionGroups = ["TapBody"];
  let bubbleTimer = null;
  let idleTimer = null;
  let audioCtx = null;
  // 指针策略状态机（唯一入口 applyPointerPolicy；优先级：拖拽/按压 > 面板 > 悬停可交互区 > 穿透）
  let ignoreState = true;
  let pointerDown = false;   // 指针在舞台（非 UI）按下
  let dragging = false;      // 已越过 4px 阈值，正在拖拽
  let hoverInteractive = false; // 指针是否位于身体/控件可交互区
  const dragStart = { x: 0, y: 0 };
  // 模型在窗口 CSS 像素中的实际包围盒（relayout 时按 originalWidth/Height × scale 计算）
  const bodyRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /* ============ PIXI / Live2D ============ */
  async function initPixi() {
    app = new PIXI.Application({
      view: canvas,
      resizeTo: canvasWrap,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    });
    app.renderer.on("resize", relayout);
  }

  function relayout() {
    if (!model) return;
    const w = app.view.clientWidth || window.innerWidth;
    const h = app.view.clientHeight || window.innerHeight;
    const im = model.internalModel;
    const s = Math.min(w / im.originalWidth, h / im.originalHeight);
    model.scale.set(s);
    model.position.set(w / 2, h / 2);
    // 模型实际包围盒（CSS 像素，居中）；originalWidth/Height 为 moc 画布尺寸
    const cw = im.originalWidth * s;
    const ch = im.originalHeight * s;
    bodyRect.x0 = (w - cw) / 2;
    bodyRect.x1 = (w + cw) / 2;
    bodyRect.y0 = (h - ch) / 2;
    bodyRect.y1 = (h + ch) / 2;
  }

  async function loadModel(id, entry) {
    if (model) {
      app.stage.removeChild(model);
      model.destroy({ children: true });
      model = null;
    }
    try {
      model = await PIXI.live2d.Live2DModel.from(`models/${encodeURIComponent(id)}/${entry.split("/").map(encodeURIComponent).join("/")}`);
      app.stage.addChild(model);
      model.anchor.set(0.5, 0.5);
      relayout();
      try {
        const man = await (await fetch(`models/${encodeURIComponent(id)}/${entry.split("/").map(encodeURIComponent).join("/")}`)).json();
        motionGroups = Object.keys(man?.FileReferences?.Motions || {}).filter((k) => k.toLowerCase() !== "idle");
        if (motionGroups.length === 0) motionGroups = ["TapBody"];
      } catch { /* 忽略清单读取失败 */ }
      model.on("hit", () => playRandomMotion());
    } catch (err) {
      console.error("[pet] 模型加载失败", err);
      showBubble("模型加载失败，去资源管理看看");
    }
  }

  function playRandomMotion() {
    if (!model) return;
    const g = motionGroups[Math.floor(Math.random() * motionGroups.length)];
    try { model.motion(g); } catch { try { model.motion(0); } catch { /* noop */ } }
  }

  /* ============ 气泡 ============ */
  function showBubble(text, ms) {
    if (!cfg || cfg.bubbles === false) return;
    bubbleText.textContent = text;
    bubbleEl.classList.remove("bubble-hidden");
    clearTimeout(bubbleTimer);
    const t = ms ?? (cfg.bubbleDuration || 6) * 1000;
    bubbleTimer = setTimeout(hideBubble, t);
    scheduleIdle();
  }
  function hideBubble() {
    bubbleEl.classList.add("bubble-hidden");
    clearTimeout(bubbleTimer);
  }
  bubbleEl.addEventListener("click", () => {
    if (cfg.bubbleClickDismiss !== false) hideBubble();
  });

  /* ============ 音效（WebAudio 合成，无需素材） ============ */
  function beep(freqs, dur = 0.16) {
    if (!cfg || cfg.sound === false) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") void audioCtx.resume();
      const vol = (cfg.volume ?? 60) / 100 * 0.25;
      let t0 = audioCtx.currentTime + 0.02;
      for (const f of freqs) {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
        t0 += dur * 0.9;
      }
    } catch { /* noop */ }
  }
  const SOUNDS = {
    turnCompleted: () => beep([659, 880], 0.14),
    turnFailed: () => beep([392, 311], 0.2),
    approval: () => beep([880, 1175], 0.13)
  };
  const LINES = {
    turnCompleted: ["任务完成啦～", "搞定啦！", "这轮做完了哦", "我这边好啦"],
    turnFailed: ["出错了……去看看吧", "好像失败了……"],
    approval: ["需要你批准哦～", "有操作等你确认", "点一下主窗口看看？"]
  };
  const IDLE_LINES = ["在忙吗？", "记得喝水～", "摸鱼中，勿扰（不是）", "今天也要加油哦", "我就在这里陪着你", "遇到卡壳的活就交给我吧"];

  function scheduleIdle() {
    clearTimeout(idleTimer);
    const delay = (4 + Math.random() * 5) * 60 * 1000;
    idleTimer = setTimeout(() => {
      if (cfg.bubbles !== false && cfg.idleLines !== false && panel.classList.contains("panel-hidden")) {
        showBubble(IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)]);
      }
      scheduleIdle();
    }, delay);
  }

  window.pet.onEvent((ev) => {
    if (ev.kind === "turnCompleted" && cfg.evTurn !== false) {
      showBubble(pick(LINES.turnCompleted));
      SOUNDS.turnCompleted();
    } else if (ev.kind === "turnFailed" && cfg.evTurn !== false) {
      showBubble(pick(LINES.turnFailed));
      SOUNDS.turnFailed();
    } else if (ev.kind === "approval" && cfg.evApproval !== false) {
      showBubble(ev.text ? `${ev.text.slice(0, 18)}${ev.text.length > 18 ? "…" : ""}` : pick(LINES.approval), 8000);
      SOUNDS.approval();
    }
  });
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /* ============ 拖拽 / 点击 / 右键 ============ */
  function panelOpen() { return !panel.classList.contains("panel-hidden"); }
  // 命中测试：面板/气泡/齿轮/右键菜单为控件区；否则用模型真实包围盒
  function hitTest(e) {
    if (panelOpen()) return true;
    if (e.target.closest && e.target.closest("#bubble, #gear, #ctx-menu")) return true;
    return e.clientX >= bodyRect.x0 && e.clientX <= bodyRect.x1 &&
           e.clientY >= bodyRect.y0 && e.clientY <= bodyRect.y1;
  }
  // 穿透策略唯一下发入口。优先级不可被任何事件路径绕过：
  // 拖拽/按压 > 面板打开 > 悬停在交互区 > 穿透
  function applyPointerPolicy() {
    const interactive = dragging || pointerDown || panelOpen() || hoverInteractive;
    const next = !interactive;
    if (next !== ignoreState) {
      ignoreState = next;
      window.pet.setIgnore(next);
    }
  }

  stage.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    if (e.target.closest("#panel, #ctx-menu, #gear, #bubble")) return; // 控件自行处理，不进入拖拽状态机
    pointerDown = true;
    dragging = false;
    dragStart.x = e.screenX;
    dragStart.y = e.screenY;
    try { stage.setPointerCapture(e.pointerId); } catch { /* noop */ }
    window.pet.drag("start", e.screenX, e.screenY);
    applyPointerPolicy(); // 按下即锁定不穿透，防止后续 move 扫到透明区把拖拽打断
  });
  stage.addEventListener("pointermove", (e) => {
    if (model && !panelOpen()) {
      const r = canvas.getBoundingClientRect();
      model.focus(e.clientX - r.left, e.clientY - r.top);
    }
    hoverInteractive = hitTest(e);
    // 只有在舞台成功 pointerdown 后才可能进入拖拽（避免按住气泡/齿轮移动产生幻影拖拽）
    if (pointerDown && !dragging &&
        Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 4) {
      dragging = true;
    }
    if (dragging) window.pet.drag("move", e.screenX, e.screenY);
    applyPointerPolicy();
  });
  const endPointer = async (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const wasDragging = dragging;
    const wasDown = pointerDown;
    if (wasDragging) {
      const res = await window.pet.drag("end", e.screenX, e.screenY);
      if (res && typeof res.facing === "number") applyFacing(res.facing);
    } else if (wasDown && !(e.target.closest && e.target.closest("#panel, #ctx-menu, #gear, #bubble"))) {
      playRandomMotion(); // 纯点击身体才触发放置动作
    }
    pointerDown = false;
    dragging = false;
    hoverInteractive = hitTest(e);
    applyPointerPolicy();
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", () => {
    pointerDown = false;
    dragging = false;
    applyPointerPolicy();
  });
  window.addEventListener("blur", () => {
    pointerDown = false;
    dragging = false;
    applyPointerPolicy();
  });
  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (panelOpen()) return;
    ctxMenu.classList.toggle("hidden");
  });
  document.addEventListener("mousedown", (e) => {
    if (!ctxMenu.classList.contains("hidden") && !e.target.closest("#ctx-menu")) ctxMenu.classList.add("hidden");
  });
  ctxMenu.addEventListener("click", async (e) => {
    const act = e.target?.dataset?.act;
    ctxMenu.classList.add("hidden");
    if (act === "settings") openPanel();
    else if (act === "hide") window.pet.hide();
    else if (act === "flip") {
      cfg = await window.pet.setConfig({ facing: -(cfg.facing || 1) });
      applyFacing(cfg.facing);
    }
  });

  // 指针离开窗口：清除悬停态（拖拽中因 dragging 优先级最高，不会被穿透）
  document.addEventListener("mouseleave", () => {
    hoverInteractive = false;
    applyPointerPolicy();
  });

  /* ============ 设置面板 ============ */
  const bindChk = (key) => {
    const el = document.querySelector(`[data-k="${key}"]`);
    if (!el) return;
    el.checked = !!cfg[key];
    el.onchange = async () => { cfg = await window.pet.setConfig({ [key]: el.checked }); applyConfig(); };
  };
  const bindRange = (key) => {
    const el = document.querySelector(`[data-k-r="${key}"]`);
    if (!el) return;
    el.value = cfg[key];
    el.oninput = () => {
      if (key === "bubbleDuration") $("#bubble-duration-val").textContent = `${el.value}s`;
    };
    el.onchange = async () => { cfg = await window.pet.setConfig({ [key]: Number(el.value) }); };
  };

  async function openPanel() {
    panel.classList.remove("panel-hidden");
    $("#panel-res").classList.add("hidden");
    $("#panel-main").classList.remove("hidden");
    cfg = await window.pet.setConfig({ panelOpen: true });
    syncPanel();
    window.pet.setIgnore(false);
  }
  async function closePanel() {
    panel.classList.add("panel-hidden");
    cfg = await window.pet.setConfig({ panelOpen: false });
  }
  $("#panel-close").onclick = closePanel;

  function applyConfig() {
    document.body.classList.toggle("menu-hidden", cfg.hideMenu === true);
    applyFacing(cfg.facing || 1);
  }
  function applyFacing(f) {
    document.body.classList.toggle("flip", f < 0);
  }

  function syncPanel() {
    $("#role-name").value = cfg.model || "";
    const sizeR = $("#size-range"), sizeN = $("#size-num");
    sizeR.value = sizeN.value = cfg.scale;
    sizeR.oninput = () => sizeN.value = sizeR.value;
    const applySize = async () => { cfg = await window.pet.setConfig({ scale: Number(sizeN.value) }); };
    sizeR.onchange = applySize;
    sizeN.onchange = applySize;

    $("#gap-num").value = cfg.scrollbarGap;
    $("#gap-num").onchange = async () => {
      const v = Math.max(0, Math.min(120, Number($("#gap-num").value) || 0));
      cfg = await window.pet.setConfig({ scrollbarGap: v });
    };
    $("#bubble-duration-val").textContent = `${cfg.bubbleDuration}s`;

    ["sound", "evTurn", "evApproval", "idleLines", "bubbleClickDismiss", "bubbles", "avoidScrollbar", "edgeSnap", "autoFlip", "hideMenu"].forEach(bindChk);
    ["volume", "bubbleDuration"].forEach(bindRange);
    applyConfig();
  }

  $("#btn-sound").onclick = () => $("#sub-sound").classList.toggle("hidden");
  $("#btn-bubble").onclick = () => $("#sub-bubble").classList.toggle("hidden");
  $("#btn-snap").onclick = () => $("#sub-snap").classList.toggle("hidden");
  gear.onclick = openPanel;
  $("#btn-import").onclick = async () => {
    const m = await window.pet.importModel();
    if (m) { cfg = await window.pet.setConfig({ model: m.id }); await loadModel(m.id, m.entry); syncPanel(); }
  };

  /* ============ 资源管理 ============ */
  $("#btn-res").onclick = async () => {
    $("#panel-main").classList.add("hidden");
    $("#panel-res").classList.remove("hidden");
    await refreshResList();
  };
  $("#res-back").onclick = () => {
    $("#panel-res").classList.add("hidden");
    $("#panel-main").classList.remove("hidden");
  };
  $("#res-open-dir").onclick = () => window.pet.openModelsDir();

  async function refreshResList() {
    models = await window.pet.listModels();
    const list = $("#res-list");
    list.innerHTML = "";
    if (models.length === 0) {
      list.innerHTML = `<div class="res-empty">还没有模型<br/>用「导入」选择 Live2D 模型文件夹（含 *.model3.json）</div>`;
      return;
    }
    for (const m of models) {
      const row = document.createElement("div");
      row.className = "res-item" + (m.id === cfg.model ? " active" : "");
      row.innerHTML = `<span class="res-name">${m.id}</span>${m.id === cfg.model ? '<span class="res-badge">使用中</span>' : ""}`;
      row.onclick = async () => {
        cfg = await window.pet.setConfig({ model: m.id });
        await loadModel(m.id, m.entry);
        syncPanel();
        await refreshResList();
      };
      const del = document.createElement("button");
      del.className = "res-del";
      del.textContent = "删除";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除模型「${m.id}」？`)) return;
        await window.pet.deleteModel(m.id);
        if (cfg.model === m.id) {
          models = await window.pet.listModels();
          if (models[0]) { cfg = await window.pet.setConfig({ model: models[0].id }); await loadModel(models[0].id, models[0].entry); }
        }
        syncPanel();
        await refreshResList();
      };
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  /* ============ 启动 ============ */
  (async () => {
    cfg = await window.pet.getConfig();
    await initPixi();
    models = await window.pet.listModels();
    const active = models.find((m) => m.id === cfg.model) || models[0];
    if (active) {
      if (active.id !== cfg.model) cfg = await window.pet.setConfig({ model: active.id });
      $("#role-name").value = active.id;
      await loadModel(active.id, active.entry);
    }
    applyConfig();
    // 初始为穿透态，等鼠标移动进来再放开
    window.pet.setIgnore(true);
    scheduleIdle();
  })().catch((err) => console.error("[pet] 启动失败", err));
})();
