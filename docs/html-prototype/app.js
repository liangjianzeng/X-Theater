/* 剧场一期原型 · 核心：路由/设备切换/全局交互件（对应 UI 规范 §3） */
"use strict";
const REG = [];
const PROTO = {
  dev: "desktop",
  cur: "S2",
  decisions: 1,
  shots: [],           // S8/S10/S11 共享镜头状态
  budget: 50, spent: 8.3,
  cast: {},            // 选角选择状态
  assetEmpty: false,
  l2: {}               // copilot 状态
};
const T = {};          // 全局辅助（screens 使用）

/* ---------- 注册 ---------- */
T.reg = (id, title, group, opts, render) => {
  REG.push(Object.assign({ id, title, group, opts: opts || {}, render }, opts || {}));
};

/* ---------- 设备切换 ---------- */
T.setDev = d => {
  PROTO.dev = d;
  document.body.className = "dev-" + d;
  document.querySelectorAll("#devseg button").forEach(b => b.classList.toggle("on", b.dataset.dev === d));
  T.go(PROTO.cur, true);
};

/* ---------- 导航 ---------- */
T.go = (id, keep) => {
  const s = REG.find(r => r.id === id); if (!s) return;
  PROTO.cur = id; T.primary = null;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.id === id));
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.dataset.screen = id;
  s.render(view);
  // H5 底 tab 高亮
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === s.tab));
  if (!keep) window.scrollTo(0, 0);
  const wrap = document.getElementById("view-wrap"); if (wrap) wrap.scrollTop = 0;
  renderRail();
};

/* 副驾右侧常驻驾驶栏（UI 规范 §5.2：主要功能不得默认隐藏；桌面常驻，H5 走底栏中央 tab）*/
function renderRail() {
  const rail = document.getElementById("ai-rail"); if (!rail) return;
  if (PROTO.dev !== "desktop" || PROTO.cur === "S1") { rail.classList.add("hidden"); rail.innerHTML = ""; return; }
  rail.classList.remove("hidden");
  const A = PROTO.assist;
  if (A.collapsed) { // 折叠＝收起不销毁：状态全部留在 PROTO.assist
    rail.classList.add("slim");
    rail.innerHTML = `<button id="rexp" class="rail-slim" title="展开副驾（状态不丢）">‹<span style="writing-mode:vertical-rl;letter-spacing:4px">副驾 · 审批 ${A.approvals.length}</span></button>`;
    rail.querySelector("#rexp").onclick = () => { A.collapsed = false; renderRail(); };
    return;
  }
  rail.classList.remove("slim");
  rail.innerHTML = "";
  T.assistant(rail, { rail: true });
}
T.expandRail = () => { if (PROTO.assist) { PROTO.assist.collapsed = false; renderRail(); } };

function buildNav() {
  const groups = ["进门", "创作驾驶", "共享", "工作台", "后台"];
  const nav = document.getElementById("nav");
  nav.innerHTML = groups.map(g => {
    const items = REG.filter(r => r.group === g);
    if (!items.length) return "";
    return `<h4>${g}</h4>` + items.map(r =>
      `<a data-id="${r.id}" class="${r.p2 ? "p2" : ""}" href="#" title="${r.note || ""}"><span>${r.id} ${r.title}</span><span class="devs">${r.tab ? "H5" : "桌面+H5"}</span></a>`
    ).join("");
  }).join("");
  nav.addEventListener("click", e => { const a = e.target.closest("a"); if (a) { e.preventDefault(); T.go(a.dataset.id); } });
}

function buildTabs() {
  const tabs = [["create", "✎", "创作", "S3"], ["project", "▤", "项目", "S4"], ["assist", "💬", "助手", "S18"], ["shoot", "▶", "拍摄", "S10"], ["me", "◍", "我的", "S14"]];
  const el = document.getElementById("tabs");
  el.innerHTML = tabs.map(t => `<button data-tab="${t[0]}" data-go="${t[3]}"><span class="ic">${t[1]}</span>${t[2]}</button>`).join("");
  el.addEventListener("click", e => { const b = e.target.closest("button"); if (b) T.go(b.dataset.go); });
}

/* ---------- §3.1 任务五态 ---------- */
T.tk = st => ({
  q:    `<span class="tk tk-q">⏳ 排队中</span>`,
  run:  `<span class="tk tk-r"><span class="dot"></span>拍摄中 <b class="num">¥<span data-cost>0.0</span></b></span>`,
  ok:   `<span class="tk tk-ok">✓ 完成</span>`,
  redo: `<span class="tk tk-warn">↻ 需重做</span>`,
  err:  `<span class="tk tk-err">! 失败 · 重试 / 换方案 / 找人看</span>`
}[st] || "");
T.freeBadge = () => `<span class="badge-free">自动补拍中（免费）</span>`;

/* ---------- §3.3 新卡胶囊 ---------- */
T.capsule = (msg, go) => {
  const c = document.getElementById("capsule");
  c.textContent = "🔔 " + msg;
  c.classList.remove("hidden");
  c.onclick = () => { c.classList.add("hidden"); (go || (() => T.go("S3")))(); };
  clearTimeout(T._capT); T._capT = setTimeout(() => c.classList.add("hidden"), 8000);
};

/* ---------- 决策点计数（§5） ---------- */
T.dec = d => {
  PROTO.decisions += d || 0;
  let c = document.getElementById("dec-counter");
  if (!c) { c = document.createElement("div"); c.id = "dec-counter"; document.body.appendChild(c); }
  c.innerHTML = `本集已拍板 <b class="num">${PROTO.decisions}</b>/5`;
  c.classList.toggle("warn", PROTO.decisions > 5);
};

/* ---------- 底部抽屉（§3.4 ConfirmSheet，含 CAS 失效演示）---------- */
T.sheet = (title, body, actions, opts) => {
  const ov = document.getElementById("overlay");
  opts = opts || {};
  ov.innerHTML = `<div class="sheet"><div class="grip"></div><h3>${title}</h3>${body}
    <div class="acts row" style="margin-top:16px;flex-wrap:wrap">${(actions || []).map((a, i) =>
      `<button class="btn ${a.kind || "btn-ghost"} ${a.big ? "big" : ""}" data-i="${i}" ${a.disabled ? "disabled" : ""}>${a.label}</button>`).join("")}
      ${opts.cas ? `<button class="btn btn-ghost" data-cas="1" style="border-style:dashed">⚠ 演示：上下文已变</button>` : ""}</div></div>`;
  ov.classList.remove("hidden");
  const close = () => ov.classList.add("hidden");
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => {
    const a = actions[+b.dataset.i]; if (a && a.onClick) a.onClick(close); else close();
  });
  const cas = ov.querySelector("[data-cas]");
  if (cas) cas.onclick = () => { // CAS 失效态：置灰主按钮+重新预览
    ov.querySelectorAll(".sheet .btn-primary").forEach(b => { b.disabled = true; });
    cas.outerHTML = `<div class="banner warn" style="margin-top:10px">上下文已变：镜头表已被更新，请重新预览后再确认</div>
      <button class="btn btn-ghost" onclick="T._reConfirm()">重新预览</button>`;
  };
  T._closeSheet = close;
  return { close };
};
T.confirm = o => {
  T._lastConfirm = o;
  T.sheet(o.title || "确认这个动作？",
    `<p class="sub">${o.summary || ""}</p>
     <div class="kv num">⏱ ${o.time || "预计 24 分钟"} · 💰 约 ${o.cost || "¥18.4"} · 🎬 ${o.shots || "拍 16 镜"}　<span class="weak">难度：标准 · 同类历史：¥17.9</span></div>`,
    [{ label: o.okLabel || "确认开跑", kind: "btn-primary", onClick: c => { c(); T.dec(1); o.onOk && o.onOk(); } },
     { label: "省着拍（自动降档）", onClick: c => { c(); T.toast("已降档：省 34%，画质增强改用标准档"); } },
     { label: "先不了", onClick: c => c() }],
    { cas: true });
};
T._reConfirm = () => { if (T._closeSheet) T._closeSheet(); if (T._lastConfirm) T.confirm(T._lastConfirm); };

/* ---------- toast（含 5s 撤销，§10）---------- */
T.toast = (msg, undo) => {
  const el = document.getElementById("toastbar");
  el.innerHTML = `<span>${msg}</span>` + (undo ? `<button>撤销 <b class="num" id="undot">5</b></button>` : "");
  el.classList.remove("hidden");
  clearTimeout(T._tT);
  if (undo) {
    let n = 5; const btn = el.querySelector("button");
    btn.onclick = () => { clearInterval(T._ti); el.classList.add("hidden"); undo(); };
    clearInterval(T._ti);
    T._ti = setInterval(() => { n--; const t = document.getElementById("undot"); if (t) t.textContent = n; if (n <= 0) { clearInterval(T._ti); el.classList.add("hidden"); } }, 1000);
  }
  T._tT = setTimeout(() => el.classList.add("hidden"), undo ? 5200 : 2600);
};

/* ---------- 图片占位（生图结果以渐变占位，含像不像角标）---------- */
T.ph = (cap, opts) => {
  opts = opts || {};
  const g = opts.grade ? `<span class="gdb"><span class="gd ${opts.grade === "hi" ? "hi" : opts.grade === "mid" ? "mid" : "lo"}" title="像不像分带"></span></span>` : "";
  return `<div class="ph ${opts.cls || ""} ${opts.dim ? "dim" : ""}">${g}${cap ? `<span class="cap">${cap}</span>` : ""}${opts.pick ? `<button class="btn btn-primary pick" style="padding:4px 10px;font-size:12px" onclick="${opts.pick}">用这张</button>` : ""}</div>`;
};

/* ---------- 镜头状态初始化（S8/S10/S11 共享）---------- */
T.shotsInit = () => {
  if (PROTO.shots.length) return;
  const names = ["雨夜码头·全景", "林晚·特写", "陈舟·回眸", "两人·对峙", "怀表·插入", "闪回·暖色", "码头·跟拍", "台词·近景", "对峙·反打", "雨滴·大特写", "船开·远景", "林晚·欲言", "陈舟·转身", "空镜·灯塔", "握手·中景", "尾帧·定格"];
  PROTO.shots = names.map((n, i) => ({
    id: i + 1, name: n, sec: [5, 4, 5, 6, 3, 4, 5, 5, 4, 3, 6, 4, 5, 3, 4, 2][i],
    st: i < 5 ? "ok" : i === 5 ? "redo" : i < 7 ? "run" : i === 7 ? "err" : i === 8 ? "free" : "q",
    cost: +(Math.random() * 1.4 + 0.6).toFixed(1), reruns: i === 5 ? 1 : 0
  }));
};

/* ---------- 键盘（§3.6）---------- */
window.addEventListener("keydown", e => {
  if (e.key === "Escape" && T._closeSheet) T._closeSheet();
  if (e.key === "Enter" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && T.primary) { e.preventDefault(); T.primary(); }
});

/* ---------- 启动 ---------- */
function boot() {
  buildNav(); buildTabs(); T.dec(0); T.shotsInit();
  document.getElementById("devseg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (b) T.setDev(b.dataset.dev);
  });
  const rt = document.getElementById("railtoggle");
  if (rt) rt.onclick = () => { const A = PROTO.assist; A.collapsed = !A.collapsed; renderRail(); };
  T.go("S2");
  setTimeout(() => T.capsule("制片组有新东西给你看 · 分镜确认卡"), 4000);
}
