/* 页面集 3 · S10 拍摄墙 / S11 审片(H5 手势) / S12 交付 / S13 资产 / S14 成本 / S15 后台 / S18 Copilot / S17 设置 */
"use strict";

/* ================= S10 拍摄进行页 ================= */
T.reg("S10", "拍摄进行页", "工作台", { tab: "shoot" }, v => {
  const h5 = PROTO.dev === "h5";
  v.innerHTML = `<div class="page">
    <div class="row spread"><b>🎥 E01 拍摄中</b><span class="weak num" id="head">已拍 7/16 · 已用 ¥8.3 · 预计还需 11 分钟</span></div>
    <div class="pbar" style="margin:8px 0 12px"><i id="pb" style="width:44%"></i></div>
    <div id="guard"></div>
    <div id="wall" style="${h5 ? "display:grid;grid-template-columns:1fr 1fr;gap:8px" : "display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px"}">
      ${PROTO.shots.map(s => `<div class="card" style="margin:0;padding:8px" data-s="${s.id}">
        <div class="ph w169"><span class="cap">#${s.id} ${s.sec}s</span></div>
        <div data-st>${T.tk(s.st === "free" ? "run" : s.st)}${s.st === "free" ? " " + T.freeBadge() : ""}</div>
      </div>`).join("")}
    </div>
    <div class="weak" style="margin-top:10px">系统发起的补拍标「自动补拍中（免费）」，不计时费（V5）· 夜间档显「排入夜间档·预计明早完成」可提即时档</div>
    <div class="row" style="margin-top:10px"><button class="btn btn-ghost" id="trig">演示：触发预算护栏</button><button class="btn btn-ghost" id="tick">演示：推进 1 镜</button></div>
  </div>`;
  let done = 7;
  const upd = () => { v.querySelector("#head").textContent = `已拍 ${done}/16 · 已用 ¥${(PROTO.spent).toFixed(1)} · 预计还需 ${Math.max(0, (16 - done) * 0.9).toFixed(0)} 分钟`; v.querySelector("#pb").style.width = (done / 16 * 100) + "%"; };
  v.querySelector("#tick").onclick = () => {
    const q = PROTO.shots.find(s => s.st === "q"); if (!q) return T.toast("队列已空，再点「触发护栏」看暂停");
    const r = PROTO.shots.find(s => s.st === "run" || s.st === "free");
    if (r) { r.st = "ok"; }
    if (q) { q.st = "run"; } done = PROTO.shots.filter(s => s.st === "ok").length; PROTO.spent += 1.1;
    const c = v.querySelector(`[data-s="${q.id}"] [data-st]`); if (c) c.innerHTML = T.tk("run");
    const rc = r && v.querySelector(`[data-s="${r.id}"] [data-st]`); if (rc) rc.innerHTML = T.tk("ok");
    upd();
  };
  v.querySelector("#trig").onclick = () => {
    v.querySelector("#guard").innerHTML = `<div class="banner warn">⚠️ 已用 <b class="num">¥41.2</b> 超出预估 20%——批量任务已挂起。继续 / 降档 / 停？<div class="row" style="margin-top:8px"><button class="btn btn-primary" style="padding:6px 14px" id="gc">继续</button><button class="btn btn-ghost" id="gd">降档（省 34%）</button><button class="btn btn-ghost" id="gs">停</button></div></div>`;
    v.querySelector("#gc").onclick = () => { v.querySelector("#guard").innerHTML = ""; T.dec(1); T.toast("已继续拍摄"); };
    v.querySelector("#gd").onclick = () => { v.querySelector("#guard").innerHTML = ""; T.toast("3 镜高价值→标准档，继续拍摄"); };
    v.querySelector("#gs").onclick = () => { v.querySelector("#guard").innerHTML = ""; T.toast("批量已停止，已完成镜头保留"); };
  };
  v.querySelectorAll("[data-s]").forEach(c => c.onclick = () => {
    const id = +c.dataset.s, s = PROTO.shots[id - 1];
    T.sheet(`#${id} ${s.name} · 拍摄详情`, `<div class="lrow"><span>状态</span>${T.tk(s.st === "free" ? "run" : s.st)}${s.st === "free" ? " " + T.freeBadge() : ""}</div><div class="lrow"><span>本镜成本</span><b class="num">¥${s.cost}</b></div><div class="lrow"><span>重拍历史</span><span>${s.reruns} 次</span></div><div class="lrow"><span>择优</span><span>★ 版本 2</span></div>`,
      [{ label: "↻ 重拍（需确认）", kind: "btn-primary", onClick: c2 => { c2(); T.confirm({ title: `重拍 #${id}`, summary: "原因将在下一个弹卡选择；先给你预估。", time: "约 3 分钟", cost: "约 ¥1.2", shots: "1 镜", okLabel: "提交重拍", onOk: () => T.toast(`#${id} 已入队`, () => T.toast("已撤销重拍")) }); } },
       { label: "★ 择优这个版本", onClick: c2 => { c2(); T.toast("已择优锁定（locked_cut）"); } },
       { label: "💬 评论", onClick: c2 => { c2(); T.toast("评论锚定到暂停帧，可 @同事"); } }]);
  });
  upd();
});

/* ================= S11 审片（H5 手势）================= */
T.reg("S11", "审片 · 移动手势", "工作台", { tab: "shoot" }, v => {
  const h5 = PROTO.dev === "h5";
  let idx = 0, passed = [];
  const strip = () => PROTO.shots.map((s, i) => `<div class="sq ${i === idx ? "cur" : ""}" data-i="${i}"><b>#${s.id}</b>${passed.includes(i) ? '<span style="position:absolute;bottom:2px;left:4px;color:var(--ok);font-weight:700">✓</span>' : ""}<i>${s.sec}s</i></div>`).join("");
  const draw = () => {
    const s = PROTO.shots[idx];
    v.innerHTML = `<div class="page" style="padding:${h5 ? "0" : "16px"}">
      ${h5 ? `<div id="swipe" style="position:relative;height:336px;background:linear-gradient(165deg,#20242E,#3A3F52 50%,#5A4038);border-radius:0 0 20px 20px;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;touch-action:none">
        <span class="watermark">#${s.id} ${s.name} · ${s.sec}s${s.st === "redo" ? " · 需重做" : ""}</span>
        <span class="play">▶</span>
        <div class="weak" style="color:#cfcac2;margin-top:10px">↑ 上滑＝下一镜（永不提交）</div>
        <div style="position:absolute;top:10px;right:12px" id="more">⋯</div>
      </div>
      <div style="padding:12px"><div class="shotstrip" id="strip2">${strip()}</div>
        <div class="row" style="margin-top:10px;gap:12px">
          <button class="btn btn-primary big" id="pass" style="flex:1;padding:16px">✓ 通过</button>
          <button class="btn btn-ghost big" id="reroll" style="flex:1;padding:16px;border:1.5px solid var(--danger);color:var(--danger)">↻ 重拍</button>
        </div>
        <div class="weak" style="text-align:center;margin-top:8px">长按画面＝帧级评论＋@同事</div></div>`
      : `<div class="row spread"><b>✂️ E01 成片审片（桌面版）</b><span class="weak num">通过 ${passed.length}/16</span></div>
        <div class="player" style="max-height:300px"><span class="play">▶</span><span class="watermark">含机审通过回执</span></div>
        <div class="shotstrip" style="margin:10px 0" id="strip2">${strip()}</div>
        <div class="row"><button class="btn btn-primary" id="pass">✓ 通过本镜</button><button class="btn btn-ghost" id="reroll">↻ 重拍本镜</button><button class="btn btn-ghost" onclick="T.go('S12')">全部批复 → 交付</button></div>`}`;
    v.querySelectorAll(".sq").forEach(q => q.onclick = () => { idx = +q.dataset.i; draw(); });
    v.querySelector("#pass").onclick = () => { passed.push(idx); T.toast(`#${PROTO.shots[idx].id} 已通过`, () => { passed.pop(); draw(); }); const nx = Math.min(idx + 1, 15); setTimeout(() => { idx = nx; draw(); }, 400); };
    v.querySelector("#reroll").onclick = () => {
      const id = PROTO.shots[idx].id;
      T.sheet(`重拍 #${id}？`, `<div class="kv num">约 ¥1.2 · 3 分钟</div><div class="row wrap" style="margin-top:8px">${["脸不像", "动作不对", "景别不对", "节奏不对", "声音不对", "太贵了"].map(r => `<button class="chip">${r}</button>`).join("")}</div>`,
        [{ label: "确认重拍", kind: "btn-primary", onClick: c => { c(); T.toast(`#${id} 重拍已提交`, () => T.toast("已撤销重拍")); } }, { label: "取消", onClick: c => c() }]);
    };
    const sw = v.querySelector("#swipe");
    if (sw) {
      let y0 = null;
      sw.addEventListener("pointerdown", e => y0 = e.clientY);
      sw.addEventListener("pointerup", e => { if (y0 !== null && e.clientY - y0 < -55) { idx = Math.min(idx + 1, 15); draw(); } y0 = null; });
      sw.addEventListener("pointerdown", e => { sw._t = Date.now(); });
      sw.addEventListener("pointerup", e => { if (sw._t && Date.now() - sw._t > 480) T.toast("💬 评论锚定到当前帧，可 @同事"); });
      v.querySelector("#more").onclick = () => T.sheet("批量待审篮", `<div class="lrow"><span>已自动跳过</span><span>3 镜（无改动）</span></div><div class="lrow"><span>待批</span><span class="num">${16 - passed.length} 镜</span></div>`, [{ label: "提交全部批复", kind: "btn-primary", onClick: c => { c(); T.toast("批复已提交（SSE 同步到桌面）"); T.go("S12"); } }]);
    }
  };
  draw();
});

/* ================= S12 交付 ================= */
T.reg("S12", "交付页", "工作台", { tab: "me" }, v => {
  const h5 = PROTO.dev === "h5";
  let step = 0;
  const draw = () => v.innerHTML = `<div class="page">
    ${h5 ? `<div class="steps">${[0, 1, 2].map(i => `<i class="${i <= step ? "on" : ""}"></i>`).join("")}</div>` : ""}
    <b>📦 E01 交付</b>
    ${step === 0 ? `<div class="row wrap" style="margin-top:10px">${["抖音 9:16", "快手 9:16", "红果 9:16", "YouTube Shorts"].map((p, i) => `<button class="chip ${i === 0 ? "sel" : ""}">${p}</button>`).join("")}</div><button class="btn btn-primary big" style="margin-top:14px" id="nx">下一步：预检</button>` : ""}
    ${step === 1 ? `<ul class="check"><li><span class="g">✓</span>分辨率 1080×1920 / 30fps</li><li><span class="g">✓</span><b>显式标识</b>位置预览（片头 2s＋右下角标）</li><li><span class="g">✓</span>隐式标识写入状态</li><li><span class="r">✗</span>字幕安全区：第 12 镜越界 3px <span class="weak">→ 自动修正后重新预检</span></li><li><span class="r">✗</span>配乐版权双许可：《码头暮色》缺<b>产物使用权</b>标记 <span class="weak">→ 换用音乐库内已许可候选</span></li></ul><div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="fix">自动修正字幕 · 换许可曲</button><button class="btn btn-primary" id="nx" disabled>下一步：导出</button></div>` : ""}
    ${step === 2 ? `<div class="kv">成片 mp4 · 水印版（内测期）<br><span class="weak">导出记录不可删（留痕）</span></div><button class="btn btn-primary big" style="margin-top:12px" id="exp">导出 → 队列任务</button>` : ""}
  </div>`;
  const bind = () => {
    const nx = v.querySelector("#nx"); if (nx) nx.onclick = () => { step++; draw(); bind(); };
    const fix = v.querySelector("#fix"); if (fix) fix.onclick = () => { T.toast("字幕已修正 · 配乐已换库内已许可候选《晚风》，双许可齐 ✓ 预检全绿"); v.querySelector("#nx").disabled = false; };
    const ex = v.querySelector("#exp"); if (ex) ex.onclick = () => { T.toast("导出任务完成 · 卡片含下载链接与水印说明"); T.capsule("导出完成：夜航西飞E01_抖音.mp4"); };
  };
  draw(); bind();
});

/* ================= S13 资产库 ================= */
T.reg("S13", "资产库 · 人工注入", "共享", { tab: "project" }, v => {
  const TABS13 = ["角色", "场景", "道具", "风格", "参考", "音乐库"];
  let tab13 = PROTO.s13tab || "角色";
  const draw = () => {
  v.innerHTML = `<div class="page">
    <div class="row" style="margin-bottom:10px">${TABS13.map(t => `<button class="chip ${t === tab13 ? "sel" : ""}" data-t13="${t}">${t}</button>`).join("")}<span class="grow"></span><button class="btn btn-primary" style="padding:5px 12px;font-size:12px" id="up">⬆ 上传新素材</button></div>
    ${tab13 === "音乐库" ? `
    <div class="card" style="padding:10px;margin:0 0 8px"><div class="row spread"><b>🎵 码头暮色</b><span class="tag">离别 · 52s</span></div><div class="row" style="margin-top:6px;gap:6px"><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" id="pl1">▶ 试听</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" id="use1">用于 E01 场2</button></div><div class="weak" style="margin-top:6px">双许可：模型协议 <b style="color:var(--ok)">ACE-Step · MIT ✓</b> · 产物使用权 <b style="color:var(--danger)">待补 ✗</b>（引用处将预检拦截）</div></div>
    <div class="card" style="padding:10px;margin:0 0 8px"><div class="row spread"><b>🎵 晚风</b><span class="tag">释然 · 38s</span></div><div class="row" style="margin-top:6px;gap:6px"><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" id="pl2">▶ 试听</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" id="use2">用于 E01 场4</button></div><div class="weak" style="margin-top:6px">双许可：模型协议 <b style="color:var(--ok)">✓</b> · 产物使用权 <b style="color:var(--ok)">✓</b> · 影子成本 ¥0.10</div></div>
    <div class="weak" style="margin-top:8px">候选来自 C9 配乐提案卡「用这条」入库 · 删除保护同资产纪律（被引用则提示受影响场次）</div>` : `
    <div class="imgs" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
      <div class="card" style="padding:8px;margin:0"><div class="ph w43"><span class="cap">林晚定妆照 v2</span></div><div class="weak">被 3 集 12 镜引用</div><div class="row"><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" id="del">删除</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px">★</button></div></div>
      <div class="card" style="padding:8px;margin:0"><div class="ph w43"><span class="cap">怀表（道具）</span></div><div class="weak">被 1 集 4 镜引用 · <span style="color:var(--warn)">人工物料</span></div><div class="row"><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px">删除</button></div></div>
      <div class="card" style="padding:8px;margin:0"><div class="ph w43 dim"><span class="cap">90 天未引用 · 建议清理</span></div><div class="weak">清理可撤销</div></div>
    </div>
    <div class="weak" style="margin-top:10px">${PROTO.dev === "h5" ? "H5 上传＝相册/相机直取（§3.7）" : "拖图进故事板格＝同一注入通道"}</div>`}
  </div>`;
  v.querySelectorAll("[data-t13]").forEach(b => b.onclick = () => { tab13 = PROTO.s13tab = b.dataset.t13; draw(); });
  const on13 = (id, fn) => { const b = v.querySelector("#" + id); if (b) b.onclick = fn; };
  on13("del", () => T.sheet("删除保护", `<div class="kv">该资产被引用：<br>· E01 场2 #3 #7 #9<br>· E02 #2<br>删除将使这些镜头标「需重做」。</div>`, [{ label: "仍然删除（可撤销 7 天）", kind: "btn-danger", onClick: c => { c(); T.toast("已删除，7 天内可撤销"); } }, { label: "取消", onClick: c => c() }]));
  on13("up", () => T.sheet("上传新素材（人工注入）", `<div class="row wrap"><button class="chip sel">图片</button><button class="chip">视频</button><button class="chip">音频</button></div><div class="kv" style="margin-top:8px">${PROTO.dev === "h5" ? "📷 相册 / 相机直取" : "点击选择文件（file input＋对象存储直传）"}<br>绑定到：镜 #9 ／ 或仅入库　标「人工物料」不进像不像评分</div>`, [{ label: "入库", kind: "btn-primary", onClick: c => { c(); T.toast("已入库并标人工物料 ✓"); } }]));
  on13("pl1", () => T.toast("▶ 试听《码头暮色》· 52s（与 S9 音轨条同源播放）"));
  on13("pl2", () => T.toast("▶ 试听《晚风》· 38s"));
  on13("use1", () => T.sheet("挂接到 E01 场2", `<div class="kv">该曲<b>产物使用权</b>标记缺失：引用后将在 S12 交付预检被拦截（V10 双许可纪律）。可先挂接占位，导出前必须换许可曲或补标记。</div>`, [{ label: "仍挂接（预检会拦）", kind: "btn-danger", onClick: c => { c(); T.toast("已挂接 · S12 预检将提示双许可缺失"); } }, { label: "取消", onClick: c => c() }]));
  on13("use2", () => { T.toast("《晚风》已挂到 E01 场4 · 双许可齐 ✓"); });
  };
  draw();
});

/* ================= S14 成本与额度 ================= */
T.reg("S14", "成本与额度（影子记账）", "共享", { tab: "me" }, v => {
  v.innerHTML = `<div class="page">
    <div class="card"><div class="row spread"><b>本集预算</b><span class="num weak">¥23 / 50</span></div><div class="pbar" style="margin-top:8px"><i style="width:46%"></i></div><div class="weak" style="margin-top:6px">内测期免费 · 影子记账（照常入账供二期定价，不扣费）</div></div>
    <b style="font-size:14px">镜级成本穿透</b> <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" onclick="T.toast('CSV 已生成（H5 走推送链接）')">导出 CSV</button>
    ${PROTO.shots.slice(0, 6).map(s => PROTO.dev === "h5"
      ? `<details class="card" style="padding:10px;margin:0 0 8px"><summary class="row"><span class="grow">#${s.id} ${s.name}</span><b class="num">¥${s.cost}</b></summary><div class="kv num">标准档 · 5s@720p · 含 1 次系统补拍（免费）</div></details>`
      : `<div class="lrow"><span>#${s.id} ${s.name}</span><span class="tag">标准档</span><span class="tag">5s@720p</span><b class="num">¥${s.cost}</b></div>`).join("")}
    <div class="hr"></div>
    <div class="card" style="border:1.5px dashed #D6D3CB"><div class="row spread"><b>积分 / 订阅 / BYOK</b><span class="tag">二期占位</span></div><div class="weak" style="margin-top:6px">价目隐藏：「内测期免费 · 正式价目商业化后公布」；BYOK 入口置灰——点击明示「商业化阶段开放」（V8）</div><button class="btn btn-ghost" disabled style="margin-top:8px">BYOK（二期开放）</button></div>
  </div>`;
});

/* ================= S15 运营最小后台（内部）· 含 §11.2 模型与运行时配置面 ================= */
T.reg("S15", "运营最小后台（内部）", "后台", {}, v => {
  const h5 = PROTO.dev === "h5";
  const TABS = ["待复审 3", "已处置", "申诉中 1", "模型与运行时"];
  let tab = PROTO.s15tab || "待复审 3";
  const chips = () => `<div class="row wrap">${TABS.map(t => `<button class="chip ${t === tab ? "sel" : ""}" data-t="${t}">${t}</button>`).join("")}<span class="grow"></span>${tab === "待复审 3" && !h5 ? `<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="T.toast('三类模拟告警已发（V6 演练）')">模拟告警</button>` : ""}</div>`;
  const bindChips = () => v.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { tab = PROTO.s15tab = b.dataset.t; draw(); });
  const okDot = `<span class="dot-st s-ok" style="display:inline-block"></span>`;

  /* ---- §11.2 模型与运行时（内部豁免面：允许模型名/端点/量化词）---- */
  function viewModels() {
    v.innerHTML = `<div class="page">${chips()}
    <div class="row spread" style="margin-top:10px"><b>模型与运行时</b><span class="weak">内部配置面 · 创作者侧唯一旋钮＝S8 档位底栏</span></div>
    <div class="card"><div class="row spread"><b>段位 × 驱动模型注册表</b><button class="btn btn-ghost" style="font-size:11px;padding:3px 10px" id="probe">一键巡检</button></div>
      <div class="lrow"><span>${okDot} 生图 · 5060 Ti</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">qwen-image-2.1-turbo-Q5_K_M</b><span class="tag">Q5_K_M（GGUF 固定）</span><span class="weak num">W-B 无头 ComfyUI :8188</span></span></div>
      <div class="weak" style="margin:-2px 0 6px 18px">生图先行纪律 · Qwen Research License 已核（ADR-001 §4）</div>
      <div class="lrow"><span>${okDot} 生图 · DGX Spark</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">MiniMax-H3-Image</b><select data-qh data-unavail="0,1" data-def="2" ${h5 ? "disabled" : ""} style="border:1px solid #DCD9D1;border-radius:8px;padding:2px 6px;font-size:12px"><option>nvfp4（首选·未发布）</option><option>int8（次选·未发布）</option><option selected>MXFP8+FP8（兜底）</option></select><span class="weak num">SGLang :8000</span></span></div>
      <div class="weak" style="margin:-2px 0 6px 18px">品牌署名仅片尾卡与「关于」页（Q13 裁决位）</div>
      <div class="lrow"><span>${okDot} 视频 · 5060 Ti</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">LTX-2.5 distilled</b><span class="tag">GGUF UD-Q4_K_XL（固定）</span><span class="weak num">:8082</span></span></div>
      <div class="lrow"><span>${okDot} 视频 · DGX Spark</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">FastH3</b><select data-qh data-def="0" ${h5 ? "disabled" : ""} style="border:1px solid #DCD9D1;border-radius:8px;padding:2px 6px;font-size:12px"><option selected>nvfp4（首选·命中）</option><option>int8（次选）</option><option>MXFP8+FP8（兜底）</option></select><span class="weak num">:8001 · pin v0.9.2</span></span></div>
      <div class="lrow"><span>${okDot} 配乐 · 5060 Ti</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">ACE-Step 1.5</b><span class="tag">MIT · 备选 Stable Audio Open（许可核证中）</span><span class="weak num">W-M 无头生乐服务 :8190</span></span></div>
      <div class="weak" style="margin:-2px 0 6px 18px">标准版裁决 · 产物带双许可标记（模型协议＋产物使用权）· 影子成本 ¥0.05–0.15/条</div>
      <div class="lrow"><span>${okDot} LLM · 峰谷</span><span class="row wrap" style="gap:6px;justify-content:flex-end"><b class="num" style="font-size:12px">DeepSeek</b><span class="tag num">sk-••••••3f2a</span><span class="weak">API 网关 · 唯一 API 侧外部依赖</span></span></div>
      ${h5 ? `<div class="weak" style="margin-top:6px">H5 降格：密钥重填／量化档／端点保存等写操作桌面保留（本面只读可达）</div>`
        : `<div class="row wrap" style="margin-top:8px"><button class="btn btn-ghost" style="padding:4px 12px" id="vfy">试调用验证</button><button class="btn btn-ghost" style="padding:4px 12px" id="key">重填 DeepSeek Key</button><button class="btn btn-ghost" style="padding:4px 12px" id="valley">峰谷调度：已开 · 批量走谷段 00:00–08:00</button></div>
      <div class="weak" style="margin-top:6px">自部署端点无密钥（自部署纪律）· 改端点/换模型走 ConfirmSheet 留痕</div>`}
    </div>
    <div class="card"><b>Agent Runtime（B10 控制面）</b><div class="weak">切换只影响 L2 runtime · 治理（工具面白名单／必答门 CAS／预算熔断／审计）恒在服务端</div>
      <div class="lrow"><span>模式 A · DSH 实例池（默认）</span><span class="row wrap" style="gap:5px;justify-content:flex-end">${okDot}<span class="weak">2/8 实例 · 独立 ~/.dsh · 出网白名单 · shell/文件/代码禁用 · pin v1.2.3</span></span></div>
      <div class="lrow"><span>模式 B · 自建轻量 loop（兜底）</span><span class="tag">契约 100% 双跑通过 · 完整实现排 M2 缓冲</span></div>
      ${h5 ? "" : `<button class="btn btn-ghost" style="margin-top:8px;padding:4px 12px" id="rt">演示：切换至模式 B</button>`}
    </div>
    <div class="card"><b>二期灰置槽位（V8 · 一期全自部署·API 最后）</b>
      <div class="row wrap" style="margin-top:8px">${["多供应商路由", "BYOK 自带密钥", "商业 API 价目"].map(t => `<button class="chip" data-p2="${t}" style="border-style:dashed;opacity:.55">${t}（二期）▾</button>`).join("")}</div>
    </div></div>`;
    bindChips();
    const on = (id, fn) => { const b = v.querySelector("#" + id); if (b) b.onclick = fn; };
    on("probe", () => T.toast("六段位端点全部健康 · 生图 p50 2.1s · 视频 p50 96s · 配乐 p50 40s · LLM p50 0.8s"));
    on("vfy", () => T.toast("试调用通过 · 延迟 0.8s · 余额正常 · 已记审计"));
    on("key", () => T.sheet("重填 DeepSeek Key", `<div class="weak">密钥永远打码显示，保存后不可回显（仅可重填）</div><input placeholder="sk-…" style="width:100%;border:1px solid #DCD9D1;border-radius:10px;padding:10px;margin-top:8px">`, [{ label: "保存并验证（留痕）", kind: "btn-primary", onClick: c => { c(); T.toast("已保存 · 试调用通过") } }]));
    on("valley", () => T.toast("峰谷策略：剧本/文案等批量 LLM 调用全部排谷段 00:00–08:00"));
    on("rt", () => T.confirm({ title: "切换 Agent Runtime 模式", summary: "L2 runtime：模式 A（DSH 实例池）→ 模式 B（自建轻量 loop）。治理仍在服务端不变，会话零感知。", time: "1 分钟内生效", cost: "¥0", shots: "仅新会话生效", okLabel: "切换（留痕）", onOk: () => T.toast("L2 runtime 已切至模式 B · 已留痕") }));
    v.querySelectorAll("[data-qh]").forEach(s => s.onchange = () => {
      const i = s.selectedIndex;
      if ((s.dataset.unavail || "").split(",").includes(String(i))) { s.selectedIndex = +s.dataset.def; T.toast("权重未发布：核实通过后才能切 · 硬规则序 nvfp4→int8→MXFP8+FP8"); }
      else if (i === 2) T.confirm({ title: "选择量化兜底档", summary: "MXFP8+FP8 为兜底档：仅当 nvfp4 与 int8 皆不存在时可用（DGX 硬规则），需附理由并生成审计记录。", time: "热重载约 40s", cost: "—", shots: "留痕", okLabel: "确认并保存", onOk: () => T.toast("已保存 · 审计记录 #Q-112 生成") });
      else T.toast("量化档已套用 · 热重载约 40s（已留痕）");
    });
    v.querySelectorAll("[data-p2]").forEach(b => b.onclick = () => T.sheet(b.dataset.p2 + " · 二期槽位", `<div class="weak">一期裁决：完全自部署 · 商业 API 最后（发起人 2026-11-20）。此处仅为接口预留，一期不提供任何真实配置入口。</div><div class="kv">接口预留：ProviderAdapter 契约 ＋ 计费字段占位（影子记账一期已按同结构采数，二期解锁即插即用）</div>`, [{ label: "知道了", kind: "btn-primary", onClick: c => c() }]));
  }

  /* ---- 复审队列（原 S15 主体）---- */
  function viewReview() {
    v.innerHTML = `<div class="page">${chips()}
    <div class="row spread" style="margin-top:10px"><b>复审工作台</b><span class="weak">机审→抽帧机审→复审→处置 全留痕</span></div>
    <div class="card"><div class="row"><div class="ph w169" style="width:90px"><span class="cap">E01 #7</span></div><div class="grow"><b>#7 码头·跟拍</b><div class="weak">机审标注帧 00:23：疑似违规元素（低置信）</div><span class="tag">申诉 SLA 剩余 <b class="num">21:40</b></span></div></div>
      <div class="row" style="margin-top:8px"><button class="btn btn-primary" style="padding:6px 14px" data-d="放行">放行</button><button class="btn btn-ghost" data-d="打回">打回</button>${h5 ? "" : `<button class="btn btn-danger" style="padding:6px 14px" data-d="下架">下架</button>`}</div>
    </div>
    <div class="card"><div class="row spread"><b>处置留痕（只读）</b><span class="weak">H5 降格：深层筛选/批量在桌面</span></div>
      <div class="lrow"><span>2f 王运营 · 11-19 21:04</span><span>打回「E02 #4」理由：品牌署名缺失</span></div>
      <div class="lrow"><span>系统 · 11-19 20:12</span><span>机审拦截「E03 #2」→ 自动送复审</span></div></div></div>`;
    bindChips();
    v.querySelectorAll("[data-d]").forEach(b => b.onclick = () => T.confirm({ title: `处置：${b.dataset.d}`, summary: "对 E01 #7 执行「" + b.dataset.d + "」", time: "即时", cost: "¥0", shots: "1 镜", okLabel: b.dataset.d + "（附理由模板）", onOk: () => T.toast("已处置并留痕（操作者/时间/前值）") }));
  }
  const draw = () => (tab === "模型与运行时" ? viewModels() : viewReview());
  draw();
});

/* ================= S18 副驾常驻驾驶栏（L2 · DSH 承载 · §5.2 三视图）================= */
/* 发起人 2026-11-20 裁决：AI 助手是主要功能（辅助驾驶），不得默认隐藏。
   桌面＝右侧常驻栏（app.js renderRail 驱动，可折叠状态不丢）；H5＝底栏中央一级 tab → S18 全屏。 */
PROTO.assist = PROTO.assist || {
  tab: "chat", collapsed: false,
  sessions: ["EP01 · 主驾会话"], ctx: ["E01 全集", "#3 林晚·特写"],
  msgs: [
    { me: 1, t: "第 3 镜脸不像，重拍" },
    { me: 0, sig: "制片组助手", t: `我查了 #3 的一致性：像不像偏低。建议换 45° 侧脸重出×4 再挑，约 ¥0.4 · 35s。<div class=toolcard><b>🛠 动作 · 重拍候选生成 #3</b><br><span class=ar-st>排队 → 执行中 → <b style=color:var(--ok)>完成</b></span> · 💰 ¥0.4 · ⏱ 35s · 档位：标准<br><a class=ar-trace onclick='T.toast("trace 已导出到 AgentRun（会话沙箱 JSONL）")'>trace ▸ AgentRun</a></div>已把「确认重拍」放进右侧<b>审批</b>视图——确认后我就开跑。` }
  ],
  tasks: [
    { t: "镜 #3 重拍 · 标准档", st: "run", by: "助手代发起", go: "S10" },
    { t: "场次 2 空镜 4 张生成", st: "q", by: "助手代发起", go: "S8" },
    { t: "#14 择优草案（2 版本）", st: "ok", by: "助手代发起", go: "S8" },
    { t: "E02 尾帧自动补拍", st: "free", by: "系统", go: "S10" }
  ],
  approvals: [
    { t: "重拍 #3（4 候选 · 45° 侧脸）", est: "¥0.4 · 35s · 标准档", ver: "上下文版本 v38 ✓" },
    { t: "#5 锁定为择优版本", est: "¥0 · 即时", ver: "上下文版本 v38 ✓" }
  ]
};
T.assistant = (host, opts) => {
  opts = opts || {}; const A = PROTO.assist;
  const draw = () => {
    host.innerHTML = `
    <div class="ar-head"><span class="ar-avatar">制</span>
      <div class="grow"><b>制片组助手</b><div class="weak">L2 副驾 · 白名单工具面 · 昂贵动作必经必答门</div></div>
      <span class="chip ar-rt" title="runtime 双模式：DSH 实例承载（默认）／自建兜底">DSH · 模式A</span>
      ${opts.rail ? `<button class="btn btn-ghost ar-collapse" title="折叠（状态不丢）" id="col">›</button>` : ""}
    </div>
    <div class="ar-sess"><button class="chip sel">${A.sessions[0]}</button><button class="chip" id="newchat">＋ 新会话</button></div>
    <div class="ar-seg">${[["chat", "对话"], ["tasks", `任务 ${A.tasks.length}`], ["approvals", `审批 ${A.approvals.length}`]].map(t =>
      `<button data-v="${t[0]}" class="${A.tab === t[0] ? "on" : ""}">${t[1]}${t[0] === "approvals" && A.approvals.length ? '<span class="ar-dot"></span>' : ""}</button>`).join("")}</div>
    <div class="ar-body" id="arb"></div>
    <div id="arfoot"></div>`;
    host.querySelector("#newchat").onclick = () => T.toast("新会话已建（旧会话可在历史条找回 · 上下文芯片随会话隔离）");
    const col = host.querySelector("#col");
    if (col) col.onclick = () => { A.collapsed = true; renderRail(); };
    host.querySelectorAll("[data-v]").forEach(b => b.onclick = () => { A.tab = b.dataset.v; draw(); });
    const b = host.querySelector("#arb");
    if (A.tab === "chat") viewChat(b, host.querySelector("#arfoot"));
    if (A.tab === "tasks") viewTasks(b);
    if (A.tab === "approvals") viewApprovals(b);
  };
  /* ---- 对话 ---- */
  function viewChat(b, foot) {
    b.innerHTML = `<div class="msgs">${A.msgs.map(m => m.me ? `<div class="msg me">${m.t}</div>` : `<div class="msg ai"><div class="sig">🤖 ${m.sig} <span class="ar-mini">DSH·模式A</span></div>${m.t}</div>`).join("")}</div>
      <div class="row wrap" style="margin:6px 0">${["查进度", "这集花了多少", "择优 #5", "把 #14 提到即时档"].map(q => `<button class="chip" data-q="${q}">${q}</button>`).join("")}</div>`;
    foot.innerHTML = `
      <div class="ar-ctx">${A.ctx.map((c, i) => `<button class="chip" data-cx="${i}">@ ${c} ×</button>`).join("")}<button class="chip ar-add" id="addctx">＋@</button></div>
      <div class="copbar"><input id="in" placeholder="指挥副驾，比如「第 3 镜脸不像，重拍」…"><button class="btn btn-primary" id="send">发送</button></div>
      <div class="ar-meter"><div class="row spread weak"><span>影子记账 · 本集</span><span class="num"><b>¥23</b>/50 · 今日副驾调用 6 次</span></div><div class="pbar" style="height:5px;margin-top:4px"><i style="width:46%"></i></div><div class="weak" style="margin-top:2px">熔断线 ¥80/集（服务端裁决，副驾不可越）</div></div>`;
    b.querySelectorAll("[data-q]").forEach(x => x.onclick = () => ask(x.dataset.q));
    foot.querySelector("#addctx").onclick = () => T.sheet("引用上下文", `<div class=weak>选择要引用的镜/场次/资产（等价于卡流 ⓘ 举证三件套；副驾按引用范围执行）</div>${["#7 码头·跟拍", "场次 3 全部", "定妆照 · 林晚", "道具 · 怀表"].map(x => `<button class="chip" style="margin:4px 6px 0 0" data-cc="${x}">＋ ${x}</button>`).join("")}`, [{ label: "完成", kind: "btn-primary", onClick: c => c() }]);
    T._anyCtxAdd = sel => { if (!A.ctx.includes(sel)) { A.ctx.push(sel); if (A.tab === "chat") draw(); } };
    document.querySelectorAll("[data-cc]").forEach(x => x.onclick = () => T._anyCtxAdd(x.dataset.cc));
    foot.querySelectorAll("[data-cx]").forEach(x => x.onclick = () => { A.ctx.splice(+x.dataset.cx, 1); draw(); });
    foot.querySelector("#send").onclick = () => { const i = foot.querySelector("#in"); if (i.value.trim()) ask(i.value.trim()); };
    foot.querySelector("#in").onkeydown = e => { if (e.key === "Enter") { if (e.target.value.trim()) ask(e.target.value.trim()); } };
  }
  function ask(q) {
    A.msgs.push({ me: 1, t: q }); A.tab = "chat"; draw();
    const box = host.querySelector(".msgs"); const last = document.createElement("div");
    last.className = "msg ai cursor-blink"; last.innerHTML = `<div class="sig">🤖 制片组助手</div>`;
    box.appendChild(last);
    const reply = /进度/.test(q) ? `队列健康：即时档 2 镜在拍，夜间档 1 镜排队（预计明早完成）。<div class=toolcard><b>🛠 动作 · 队列与成本查询</b>（只读）<br><span class=ar-st>完成</span> · ⏱ 0.2s · <a class=ar-trace onclick="T.toast('trace 已导出到 AgentRun')">trace ▸ AgentRun</a></div>`
      : /花|多少/.test(q) ? `本集已用 <b class="num">¥23.0</b>/50（影子记账，不扣费）；镜级明细见成本页。<div class=toolcard><b>🛠 动作 · 成本查询</b>（只读）<br><span class=ar-st>完成</span> · <a class=ar-trace onclick="T.toast('trace 已导出到 AgentRun')">trace ▸ AgentRun</a></div>`
        : /择优/.test(q) ? `#5 有 2 个版本，我推荐<b>版本 2</b>（一致性更高）。确认后锁定。已放审批。<div class=toolcard><b>🛠 动作 · 择优版本锁定（提案）</b><br><span class=ar-st>待你审批</span> · 💰 ¥0 · 即时</div>`
          : /即时/.test(q) ? `#14 提即时档需补差价 <b class="num">¥0.6</b>。已放审批。<div class=toolcard><b>🛠 动作 · 提到即时档（提案）</b><br><span class=ar-st>待你审批</span> · 💰 ¥0.6 · 省 4 小时</div>`
            : /配乐|音乐|BGM/i.test(q) ? `好，我按场次情绪出了 3 条候选配乐（离别/压抑/释然各一），试听后告诉我用哪条。<div class=toolcard><b>🛠 动作 · 配乐候选生成（提案）</b><br><span class=ar-st>排队 → 执行中</span> · 💰 ¥0.12 · 每条约 40s</div>`
              : `收到。这个动作涉及生成费用，我会先给你预估卡，确认后入队。<div class=toolcard><b>🛠 动作 · 生成候选（提案）</b><br><span class=ar-st>待确认</span> · 💰 ¥1.2 · ⏱ 3 分钟</div>`;
    setTimeout(() => {
      let i = 0; last.classList.remove("cursor-blink");
      const tick = setInterval(() => {
        i += 7; last.innerHTML = `<div class="sig">🤖 制片组助手 <span class="ar-mini">DSH·模式A</span></div>` + reply.slice(0, i);
        if (i >= reply.length) { clearInterval(tick); last.innerHTML = `<div class="sig">🤖 制片组助手 <span class="ar-mini">DSH·模式A</span></div>` + reply + `<div class="row" style="margin-top:6px"><button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="T.toast('已复制')">复制</button></div>`;
          if (reply.includes("提案")) A.approvals.push({ t: "副驾提案 · " + q.slice(0, 14), est: reply.match(/💰 [^·]+/)?.[0]?.slice(3) || "见预估", ver: "上下文版本 v38 ✓" }); }
      }, 22);
    }, 320);
  }
  /* ---- 任务（助手代发起可见）---- */
  function viewTasks(b) {
    b.innerHTML = A.tasks.length ? A.tasks.map((t, i) => `<div class="lrow"><div class="grow"><b style="font-size:13px">${t.t}</b><div class="weak">${t.by}</div></div><div class="row" style="gap:6px">${t.st === "free" ? T.freeBadge() : T.tk(t.st)}<button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-go="${t.go}">去看</button><button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-kill="${i}">停</button></div></div>`).join("")
      : `<div class="empty">暂无代跑任务<br><span style="font-size:12px">助手替你跑的活都会出现在这里（五态＋下一步）</span></div>`;
    b.querySelectorAll("[data-go]").forEach(x => x.onclick = () => T.go(x.dataset.go));
    b.querySelectorAll("[data-kill]").forEach(x => x.onclick = () => { T.confirm({ title: "停止该任务？", summary: "已消耗的份额保留在影子记账，不再继续。", time: "—", cost: "—", shots: "1 任务", okLabel: "停止", onOk: () => { A.tasks.splice(+x.dataset.kill, 1); draw(); T.toast("已停止并留痕"); } }); });
  }
  /* ---- 审批（必答门收件箱，不藏在对话流里）---- */
  function viewApprovals(b) {
    b.innerHTML = A.approvals.length ? A.approvals.map((a, i) => `<div class="card" style="padding:12px;margin-bottom:10px"><b style="font-size:13px">${a.t}</b><div class="kv num">💰 ${a.est} · 🔒 ${a.ver}</div><div class="row" style="margin-top:8px"><button class="btn btn-primary" style="padding:5px 14px" data-ap="${i}">确认执行</button><button class="btn btn-ghost" style="padding:5px 14px" data-rj="${i}">驳回</button></div></div>`).join("")
      : `<div class="empty">审批已清空<br><span style="font-size:12px">昂贵动作都在这里等你拍板（令牌 hash＋CAS＋TTL 服务端校验）</span></div>`;
    b.querySelectorAll("[data-ap]").forEach(x => x.onclick = () => T.confirm({ title: "副驾代发起 · 必答门", summary: A.approvals[+x.dataset.ap].t + "（CAS 上下文版本已校验）", time: "约 35 秒–3 分钟", cost: "约 ¥0.4–1.2", shots: "1 镜", okLabel: "确认执行", onOk: () => { A.approvals.splice(+x.dataset.ap, 1); A.tasks.unshift({ t: "由审批执行 · " + A.approvals.length, st: "q", by: "助手代发起", go: "S10" }); draw(); T.toast("已执行（initiated_by：copilot · 留痕 AgentRun）"); } }));
    b.querySelectorAll("[data-rj]").forEach(x => x.onclick = () => { A.approvals.splice(+x.dataset.rj, 1); draw(); T.toast("已驳回 · 驳回原因已留痕（喂给技能候选池）"); });
  }
  draw();
};
/* S18 页＝H5 底栏中央「助手」tab 落点（全屏沉浸，§5.2 同构）*/
T.reg("S18", "副驾驾驶栏（L2）", "创作驾驶", { tab: "assist" }, v => {
  v.innerHTML = `<div class="page"><div id="arfull"></div></div>`;
  T.assistant(v.querySelector("#arfull"), { full: true });
  T.primary = () => { const i = v.querySelector("#in"); if (i && i.value.trim()) { i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); } };
});

/* ================= S17 设置 ================= */
T.reg("S17", "设置 · 成员 · 分享", "共享", { tab: "me", p2: true }, v => {
  v.innerHTML = `<div class="page">
    <div class="lrow"><span>工作室</span><span class="tag">夜航工作室（邀请制内测）</span></div>
    <div class="lrow"><span>成员</span><span class="tag">3 人 · 邀请</span></div>
    <div class="lrow"><span>分享链接</span><span class="tag">审片只读链接 ✓</span></div>
    <div class="lrow"><span>关于</span><span class="weak">片尾卡与本页含 MiniMax-H3 品牌署名位（Q13 裁决位）</span></div>
    <div class="lrow"><span>PWA</span><span class="tag">可「添加到主屏」</span></div>
  </div>`;
});
