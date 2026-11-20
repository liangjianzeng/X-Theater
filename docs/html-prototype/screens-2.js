/* 页面集 2 · S4 项目壳 / S5 剧本 / S6 选角 / S7 美术 / S8 故事板 / S9 样片 */
"use strict";

/* ================= S4 项目树 ================= */
T.reg("S4", "项目树＋工作台壳", "共享", { tab: "project" }, v => {
  const h5 = PROTO.dev === "h5";
  v.innerHTML = `<div class="page">
    <div class="row spread"><div><span class="tag">《夜航西飞》</span> <b>E01 · 雨夜码头</b></div>
      <div class="row"><button class="btn btn-ghost" style="font-size:12px;padding:4px 10px">🔗 分享链接</button><button class="btn btn-ghost" style="font-size:12px;padding:4px 10px">⚙ 画幅/平台</button></div></div>
    <div class="weak" style="margin:4px 0 10px">深链 /series/night-flight/ep/1/scene/2/shot/6（可分享·宿主无关）${h5 ? " · 树收进抽屉" : ""}</div>
    <div class="tree card">
      <div class="node"><span class="dot-st s-ok"></span>📁 系列《夜航西飞》<span class="grow"></span><span class="weak num">12 集</span></div>
      <div class="node lv2"><span class="dot-st s-run"></span>E01 雨夜码头 <span class="grow"></span><span class="weak num">60s · 12/16 镜</span></div>
      <div class="node lv3"><span class="dot-st s-ok"></span>场1 舱内 <span class="grow"></span><span class="weak num">4 镜 ✓</span></div>
      <div class="node lv3 on"><span class="dot-st s-run"></span>场2 码头 <span class="grow"></span><span class="weak num">12/16</span></div>
      ${PROTO.shots.slice(4, 10).map(s => `<div class="node lv3" style="font-size:12px"><span class="dot-st ${s.st === "ok" ? "s-ok" : s.st === "run" || s.st === "free" ? "s-run" : s.st === "redo" ? "s-warn" : "s-idle"}"></span>#${s.id} ${s.name}<span class="grow"></span><span class="weak num">${s.sec}s</span></div>`).join("")}
      <div class="node lv2"><span class="dot-st s-idle"></span>E02 灯塔 <span class="grow"></span><span class="weak">未开拍</span></div>
    </div>
    <div class="row"><button class="btn btn-ghost" onclick="T.go('S5')">📖 剧本视图</button><button class="btn btn-ghost" onclick="T.go('S8')">🎬 故事板</button><button class="btn btn-ghost" onclick="T.go('S13')">🗂 资产库</button></div>
    <div class="empty" style="padding:18px"><span class="weak">树节点状态点＝任务五态（§3.1）；空态示例：删被引资产会被拦 →</span> <button class="btn btn-ghost" style="font-size:12px;padding:3px 10px" onclick="T.go('S13')">试试</button></div>
  </div>`;
});

/* ================= S5 剧本视图（台词本） ================= */
T.reg("S5", "剧本视图 · 台词本", "共享", { tab: "project" }, v => {
  const lines = [
    { r: "林晚", t: "最后一班船，你还来。", m: "克制", sec: 3 },
    { r: "陈舟", t: "密电在你身上。", m: "试探", sec: 2 },
    { r: "林晚", t: "我烧了。现在你只剩我。", m: "锋利", sec: 4 },
    { r: "旁白", t: "雨声渐密，汽笛第一次响。", m: "—", sec: 3 }
  ];
  v.innerHTML = `<div class="page">
    <div class="row spread"><b>场2 · 台词本</b><span class="weak num">预计 12s</span></div>
    <div class="banner warn hidden" id="stalebar">✏️ 台词改动后，相关镜头会标「需重做」，不会自动重拍</div>
    <div class="card" id="lines">${lines.map((l, i) => `<div class="lrow"><span class="tag">${l.r}</span><span class="grow" data-ed="${i}" style="${PROTO.dev === "h5" ? "font-size:12px" : "cursor:text;border-bottom:1px dashed transparent"}">“${l.t}”</span><span class="chip" style="font-size:11px">${l.m}</span><span class="weak num">${l.sec}s</span><button class="btn btn-ghost" data-hear="${i}" style="padding:3px 9px;font-size:12px">试听</button></div>`).join("")}</div>
    ${PROTO.dev === "h5" ? `<div class="weak">长按行＝改角色/改情绪/删句</div>` : `<div class="weak">点台词可行内编辑；hover 红点看人话机检说明</div>`}
    <div class="row" style="margin-top:12px"><span class="tk tk-err" style="font-size:11px">! 第 3 句机检：引用道具「密电」未入库 · 点我人话说明</span></div>
    <button class="btn btn-primary big" id="lock" style="margin-top:14px">锁定台词本 → 进美术</button>
  </div>`;
  v.querySelectorAll("[data-hear]").forEach(b => b.onclick = () => T.toast("🔊 试听（自部署音色 · 缓存命中 <500ms）"));
  v.querySelectorAll("[data-ed]").forEach(sp => sp.onclick = () => {
    sp.contentEditable = true; sp.focus(); sp.style.borderBottom = "1px dashed var(--brand)";
    sp.onblur = () => { sp.contentEditable = false; sp.style.borderBottom = "none"; v.querySelector("#stalebar").classList.remove("hidden"); T.toast("第 5、9 镜已标「需重做」", () => v.querySelector("#stalebar").classList.add("hidden")); };
  });
  v.querySelector("#lock").onclick = () => T.confirm({ title: "锁定台词本", summary: "锁定后进入美术阶段；解锁会触发全局「需重做」连锁提醒。", time: "即时", cost: "¥0", shots: "4 句 / 关联 16 镜", okLabel: "锁定", onOk: () => T.go("S7") });
  T.primary = () => v.querySelector("#lock").click();
});

/* ================= S6 选角页（含诊断卡） ================= */
T.reg("S6", "选角页 · 诊断卡", "共享", { tab: "project" }, v => {
  let tries = 0;
  v.innerHTML = `<div class="page">
    <div class="row spread"><b>《夜航西飞》演员表</b><button class="btn btn-ghost" style="padding:4px 10px;font-size:12px">＋加角色</button></div>
    <div class="imgs" style="grid-template-columns:repeat(2,1fr);margin-top:10px" id="wall">
      ${T.ph("林晚 · 候选A", { grade: "hi", pick: `T.toast('已定妆：像不像 ✓ 高档')` })}
      ${T.ph("林晚 · 候选B", { grade: "mid", pick: `T.toast('已定妆')` })}
      ${T.ph("陈舟 · 候选A", { grade: "lo", pick: `T.toast('已定妆')` })}
      ${T.ph("陈舟 · 候选B", { grade: "mid", pick: `T.toast('已定妆')` })}
    </div>
    <div class="row"><button class="btn btn-ghost" id="batch">🔄 换一批</button><span class="weak">选中即定妆照（全剧锚点）</span></div>
    <div class="hr"></div>
    <div class="card"><div class="row spread"><b>音色卡 · 林晚</b><span class="weak">自部署音色目录</span></div>
      <div class="row" style="margin-top:6px">${["声线 A · 低而稳", "声线 B · 微哑", "声线 C · 明亮"].map(n => `<button class="btn btn-ghost" style="font-size:12px;padding:4px 10px" onclick="T.toast('🔊 试听 3 句')">▶ ${n}</button>`).join("")}<button class="btn btn-ghost" style="font-size:12px;padding:4px 10px">换音色</button></div></div>
    <button class="btn btn-primary big" id="sign" style="margin-top:10px">全员签约</button>
    <div class="weak" style="margin-top:8px">三视图 tab：占位灰（可砍项）</div>
  </div>`;
  v.querySelector("#batch").onclick = () => {
    tries++; v.querySelectorAll("#wall .ph").forEach(p => { p.style.background = `linear-gradient(135deg,hsl(${Math.random() * 360},32%,76%),hsl(${Math.random() * 360},30%,64%))`; });
    if (tries >= 2) diag();
  };
  function diag() {
    T.sheet("诊断卡 · 为什么「脸不像」", `
      <div class="row"><span class="gd lo"></span><b>当前像不像：偏低</b><span class="weak">趋势：连续 2 次抽卡未改善</span></div>
      <div class="hr"></div><b style="font-size:13px">疑似成因</b>
      <div class="row wrap" style="margin-top:6px"><button class="chip sel">角度问题</button><button class="chip">描述不符</button><button class="chip">路线问题</button></div>
      <div class="hr"></div><b style="font-size:13px">修复方案（选一）</b>
      <div class="lrow"><span>换 45° 侧脸重出 ×4</span><b class="num">¥0.4 · 35s</b></div>
      <div class="lrow"><span>按外貌字段重写描述重出</span><b class="num">¥0.4 · 40s</b></div>
      <div class="lrow"><span>换生图路线（高价值档）</span><b class="num">¥1.2 · 25s</b></div>`,
      [{ label: "执行修复", kind: "btn-primary", onClick: c => { c(); T.toast("修复任务已入队（系统发起，免费不计入拍摄费）"); } },
       { label: "转人工处理", onClick: c => { c(); T.toast("已转运营人工队列（同因 ≥2 次触发）"); } }]);
  }
  v.querySelector("#sign").onclick = () => T.confirm({ title: "全员签约", summary: "定妆照将作为<b>全剧一致性锚点</b>锁定。解锁需确认+留痕。", time: "即时", cost: "¥0", shots: "影响 192 镜", okLabel: "签约", onOk: () => T.toast("演员表已锁定 ✓") });
});

/* ================= S7 美术页 ================= */
T.reg("S7", "美术页 · 风格圣经", "工作台", {}, v => {
  v.innerHTML = `<div class="page">
    <b>风格圣经（已自动推导）</b>
    <div class="row wrap" style="margin:8px 0">${["民国 noir", "冷雨暖灯", "高对比剪影", "青橙分级", "胶片颗粒"].map((c, i) => `<button class="chip ${i < 3 ? "sel" : ""}">${c}</button>`).join("")}</div>
    <div class="imgs" style="grid-template-columns:repeat(3,1fr)">${T.ph("定场照 · 码头 ×1", { cls: "w43" })}${T.ph("定场照 · 船舱 ×2", { cls: "w43" })}${T.ph("定场照 · 灯塔 ×3", { cls: "w43" })}</div>
    <div class="weak">定场照 ×3/场（单人模式可砍项）· chips 微调即时重生成预览（限 6 次/会话）</div>
    <button class="btn btn-primary big" style="margin-top:14px" id="lockart">锁定美术包</button>
  </div>`;
  v.querySelector("#lockart").onclick = () => T.confirm({ title: "锁定美术包", summary: "锁定后全局风格前缀注入所有后续生图/视频任务。", time: "即时", cost: "¥0", shots: "影响后续全部镜头", okLabel: "锁定", onOk: () => { T.dec(1); T.go("S8"); } });
});

/* ================= S8 故事板 ================= */
T.reg("S8", "故事板 · 导演主视图", "工作台", {}, v => {
  const h5 = PROTO.dev === "h5";
  v.innerHTML = `<div class="page">
    <div class="row spread"><b>《夜航西飞》E01</b><span class="weak">📖 🎭 🎨 <b style="color:var(--brand)">🎬</b> 🎞 🎥 ✂️</span></div>
    <div class="row spread" style="margin:6px 0"><span>▣ 场次2 · 雨夜码头（16 镜）</span><span class="weak num">预算 <b>¥23</b>/50 · 12/16 镜</span></div>
    <div class="row" style="margin-bottom:8px"><button class="btn btn-ghost" style="font-size:12px;padding:3px 10px" id="multi">多选</button><span class="weak">${h5 ? "长按镜头格多选→批量重拍；拖拽排序（↑↓ 兜底）" : "框选→批量重拍；拖拽排序（长按兜底）"}</span></div>
    <div id="grid" style="${h5 ? "display:flex;flex-direction:column;gap:10px" : "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px"}">
      ${PROTO.shots.map(s => `<div class="card" style="margin:0;padding:8px" data-shot="${s.id}">
        <div class="ph ${h5 ? "w169" : "w43"}" title="#${s.id} ${s.name}"><span class="cap">#${s.id} ${h5 ? s.name : ""} ${s.sec}s</span></div>
        <div class="row" style="margin-top:6px">${T.tk(s.st === "free" ? "run" : s.st)}${s.st === "free" ? T.freeBadge() : ""}</div>
        ${h5 ? `<div class="row" style="margin-top:6px"><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px">↑</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px">↓</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" data-detail="${s.id}">详情</button></div>` : ""}
      </div>`).join("")}
      <div class="card" style="margin:0;display:flex;align-items:center;justify-content:center;min-height:110px;border:1.5px dashed #D6D3CB;color:var(--ink-3)">＋新镜（2s 空镜模板）</div>
    </div>
    <div class="weak" style="margin-top:8px">格子 hover「换一张」→生图队列；拖图进格＝人工注入（标人工物料）${h5 ? "；长按拖动排序或 ↑↓ 兜底" : ""}</div>
    <div class="gradebar">
      <span class="weak">⚡自部署档</span>
      <button class="chip sel" data-g>标准</button><button class="chip" data-g>高价值</button><button class="chip" data-g>夜间</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" disabled style="font-size:11px;padding:3px 8px" title="二期槽位（V8）：点击明示「商业化阶段开放」">多供应商路由 →二期</button>
      <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="T.sheet('手动指定档位','<div class=lrow><span>分辨率</span><span class=tag>720p</span></div><div class=lrow><span>步数</span><span class=tag>8 步</span></div><div class=lrow><span>量化档</span><span class=tag>nvfp4（无则 int8 → MXFP8+FP8）</span></div>',[{label:'应用',kind:'btn-primary',onClick:c=>{c();T.toast('档位已按优先级套用')}}])">手动▾</button>
    </div>
  </div>`;
  v.querySelectorAll("[data-detail]").forEach(b => b.onclick = () => detail(+b.dataset.detail));
  if (!h5) v.querySelectorAll("#grid .card[data-shot]").forEach(c => c.onclick = () => detail(+c.dataset.shot));
  function detail(id) {
    const s = PROTO.shots[id - 1];
    T.sheet(`#${id} ${s.name}`, `<div class="player" style="max-height:200px"><span class="play">▶</span></div>
      <div class="row wrap" style="margin:8px 0"><span class="tag">出场：林晚</span><span class="tag">陈舟</span><span class="tag">道具：怀表</span><span class="weak num">${s.sec}s</span></div>
      <div class="lrow"><span>重拍历史</span><span class="tag">${s.reruns} 次</span><button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" onclick="T.toast('左右拖杆对比上一版')">对比上一版</button></div>
      <div class="lrow"><span>版本择优</span><span>★ 已择优</span></div>`,
      [{ label: "↻ 重拍", kind: "btn-primary", onClick: c => { c(); rerun(s); } },
       { label: "🔒 锁定", onClick: c => { c(); T.toast(`#${id} 已锁定`); } },
       { label: "关闭", onClick: c => c() }]);
  }
  function rerun(s) {
    T.sheet("重拍 #${id}：为什么不对？".replace("${id}", s.id), `<div class="row wrap">${["脸不像", "动作不对", "景别不对", "节奏不对", "声音不对", "太贵了"].map(r => `<button class="chip" data-r="${r}">${r}</button>`).join("")}</div>`,
      [{ label: "提交重拍", kind: "btn-primary", disabled: true, onClick: c => { c(); } }], {});
    const ov = document.getElementById("overlay"); const okBtn = ov.querySelector(".btn-primary");
    let picked = null;
    ov.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { ov.querySelectorAll("[data-r]").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); picked = b.dataset.r; okBtn.disabled = false; });
    okBtn.onclick = () => {
      T._closeSheet();
      if (picked === "脸不像") { T.toast("走诊断卡（见选角页演示）", null); T.go("S6"); return; }
      if (picked === "太贵了") { T.sheet("降档预览", `<div class="kv num">省 34% · ¥1.2→¥0.8<br>影响：高价值档→标准档（片尾署名镜头保留）</div>`, [{ label: "按降档重拍", kind: "btn-primary", onClick: c => { c(); T.toast(`#${s.id} 重拍中 · 约 ¥0.8 · 3 分钟`, () => T.toast("已撤销")); } }]); return; }
      T.toast(`#${s.id} 已入队重拍 · 约 ¥1.2 · 3 分钟`, () => T.toast("已撤销重拍"));
    };
  }
  const mb = v.querySelector("#multi"); if (mb) mb.onclick = () => T.confirm({ title: "批量重拍（多选 6 镜）", summary: "已选：#6–#11。", time: "预计 14 分钟", cost: "约 ¥6.8", shots: "拍 6 镜", okLabel: "批量重拍" });
});

/* ================= S9 样片 ================= */
T.reg("S9", "样片播放器", "共享", { tab: "create" }, v => {
  v.innerHTML = `<div class="page" style="max-width:520px;margin:0 auto">
    <div class="row spread"><b>E01 样片 · 60s</b><span class="chip">竖屏 9:16</span></div>
    <div class="player" style="margin:10px 0"><span class="play">▶</span><span class="watermark">非正式画面</span></div>
    <div class="shotstrip">${PROTO.shots.map((s, i) => `<div class="sq ${i === 0 ? "cur" : ""}" title="点击 seek＋跳转编辑"><b>#${s.id}</b><i>${s.sec}s</i></div>`).join("")}</div>
    <div class="row" style="gap:4px;margin-top:6px" title="音轨条（配乐标准版）">
      <span class="chip" style="font-size:11px;padding:2px 10px;background:var(--brand-soft);min-height:24px" id="mus1">🎵 场1《晚风》</span>
      <span class="chip" style="font-size:11px;padding:2px 10px;border-style:dashed;color:var(--weak);min-height:24px" id="mus2">＋ 场2 待配乐</span>
      <span class="chip" style="font-size:11px;padding:2px 10px;background:var(--brand-soft);min-height:24px" id="mus3">🎵 场3《汽笛》</span>
      <span class="chip" style="font-size:11px;padding:2px 10px;border-style:dashed;color:var(--weak);min-height:24px" id="mus4">＋ 场4 待配乐</span>
    </div>
    <div class="card" style="margin-top:12px"><div class="row"><div class="ph w169" style="width:88px"></div><div class="grow"><b style="font-size:13px">真实试拍样（单镜 5s）</b><div class="weak">这就是正式画面水平 —— 预期校准件</div></div><button class="btn btn-ghost" onclick="T.toast('🔊▶ 播放 5s')">▶</button></div></div>
    <button class="btn btn-primary big" id="go" style="margin-top:12px">开机 🎬</button>
  </div>`;
  v.querySelector("#go").onclick = () => T.confirm({ title: "开机确认", summary: "16 镜批量开拍（自部署档）。超预算 20% 自动暂停。", time: "预计 24 分钟", cost: "约 ¥18.4", shots: "拍 16 镜", onOk: () => T.go("S10") });
  ["mus1", "mus3"].forEach(id => v.querySelector("#" + id).onclick = () => T.toast("▶ 试听已挂配乐（与音乐库同源）"));
  ["mus2", "mus4"].forEach(id => v.querySelector("#" + id).onclick = () => T.sheet("该场配乐候选已备好", `<div class="kv">制片组已按场次情绪出了 3 条候选（提案卡 · C9）。</div>`, [{ label: "去卡流试听选曲", kind: "btn-primary", onClick: c => { c(); T.go("S3"); } }, { label: "稍后", onClick: c => c() }]));
  T.primary = () => v.querySelector("#go").click();
});
