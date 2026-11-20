/* 页面集 1 · S1 登录 / S2 首页 / S16 首跑 / S3 提案卡流（UI 规范 §4–§5） */
"use strict";

/* ================= S1 登录 ================= */
T.reg("S1", "登录 · 邀请制进门", "进门", { tab: "create" }, v => {
  v.innerHTML = `<div class="page" style="max-width:400px;margin:30px auto">
    <div class="card">
      <div class="row" style="gap:10px;margin-bottom:14px"><span class="tb-logo" style="width:38px;height:38px;font-size:20px">剧</span><b style="font-size:18px">剧场</b><span class="weak">AI 短剧 · 一句话到成片</span></div>
      <div class="row" style="margin-bottom:10px"><input class="grow" placeholder="手机号" style="border:1px solid #DCD9D1;border-radius:10px;padding:11px 12px;width:100%"></div>
      <div class="row" style="margin-bottom:10px"><input class="grow" placeholder="验证码" style="border:1px solid #DCD9D1;border-radius:10px;padding:11px 12px"><button class="btn btn-ghost" id="code">获取验证码</button></div>
      <div class="row" style="margin-bottom:14px"><input class="grow" placeholder="邀请码（内测必填）" style="border:1px solid #DCD9D1;border-radius:10px;padding:11px 12px"></div>
      <button class="btn btn-primary big" id="go">进入剧场 ▶</button>
      <div class="hr"></div>
      <div class="weak">没有邀请码？<a href="#" style="color:var(--brand)" id="apply">申请内测</a>（留资后按序邀请）</div>
    </div>
    <div class="weak" style="text-align:center">内测协议 · 隐私政策已挂出（V7）</div>
  </div>`;
  v.querySelector("#code").onclick = e => { let n = 60; e.target.disabled = true; e.target.textContent = n + "s 后重发"; const t = setInterval(() => { n--; e.target.textContent = n + "s 后重发"; if (n <= 0) { clearInterval(t); e.target.disabled = false; e.target.textContent = "获取验证码"; } }, 1000); };
  v.querySelector("#go").onclick = () => T.go("S16");
  v.querySelector("#apply").onclick = e => { e.preventDefault(); T.toast("已提交内测申请，通过后短信通知"); };
  T.primary = () => T.go("S16");
});

/* ================= S2 首页（四态） ================= */
T.reg("S2", "首页 · 四入口+模板流", "创作驾驶", { tab: "create" }, v => {
  const h5 = PROTO.dev === "h5";
  let state = 2;
  const states = ["无项目", "有项目（继续）", "有必答卡", "拍摄队列维护"];
  const draw = () => {
    v.innerHTML = `<div class="page">
      <div class="row wrap" style="margin-bottom:12px">${states.map((s, i) => `<button class="chip ${state === i ? "sel" : ""}" data-s="${i}">${s}</button>`).join("")}</div>
      ${state === 3 ? `<div class="banner info">🛠 ${h5 ? "拍摄队列入库排队中，不影响你继续编辑" : "拍摄队列入库排队中，不影响你继续编辑"}<span class="weak">　批量按钮已暂灰</span></div>` : ""}
      ${state === 2 ? `<div class="card" style="border:1.5px solid var(--brand)"><div class="row spread"><div><b>《夜航西飞》E01</b><div class="weak">🎥 拍摄中 12/16 · 已用 <b class="num">¥23</b>/<span class="num">50</span></div></div><button class="btn btn-primary">继续 ▶</button></div><div class="pbar" style="margin-top:8px"><i style="width:75%"></i></div></div>` : ""}
      ${state === 2 ? `<div class="card"><div class="row spread"><span>📌 演员表等你拍板（C2 必答卡 · 停留 2 天）</span><button class="btn btn-ghost">去拍板</button></div></div>` : ""}
      ${h5
        ? `<div class="card"><textarea placeholder="一句话、一段故事、或整篇小说，都行…" style="width:100%;border:none;outline:none;min-height:64px;background:none"></textarea><button class="btn btn-primary big" style="margin-top:6px">开拍 ▶</button></div>`
        : `<div class="card"><div class="row"><input class="grow" placeholder="一句话、一段故事、或整篇小说，都行…" style="border:none;outline:none;font-size:16px"><button class="btn btn-primary">开拍 ▶</button></div></div>`}
      <div class="row wrap" style="margin-bottom:16px">${["🎬 小说改编", "💡 一句话灵感", "🧩 模板开跑", "📁 导入分镜表"].map(t => `<div class="card grow" style="margin:0 8px 8px 0;text-align:center;padding:18px 8px;cursor:pointer"><div style="font-size:20px">${t.split(" ")[0]}</div>${t.split(" ")[1]}</div>`).join("")}</div>
      <h1 class="page-t" style="font-size:16px;margin-bottom:8px">模板流</h1>
      <div class="${h5 ? "" : "row"}" style="${h5 ? "display:flex;flex-direction:column" : "gap:12px"}">
        ${["逆袭 · 战神归来", "甜宠 · 三次约会", "悬疑 · 电梯停电"].map((n, i) => `<div class="card" style="${h5 ? "" : "flex:1;margin-bottom:0"}">
          <div class="player" style="aspect-ratio:9/12;max-height:180px"><span class="play">▶</span>${i === 0 && !h5 ? '<span class="watermark">demo 静音自动播 3s</span>' : ""}${h5 ? '<span class="watermark">Wi-Fi 静音自动播</span>' : ""}</div>
          <div class="row spread" style="margin-top:8px"><b>${n}</b><span class="weak num">成片 48s</span></div>
          <button class="btn btn-ghost" style="width:100%;margin-top:6px">用这个模板</button></div>`).join("")}
      </div>
      ${state === 0 ? `<div class="empty"><div style="font-size:30px">🎬</div>还没有项目<br><button class="btn btn-primary" onclick="T.go('S16')">说一句试试</button></div>` : ""}
    </div>`;
    v.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { state = +b.dataset.s; draw(); });
  };
  draw();
});

/* ================= S16 首跑体验 ================= */
T.reg("S16", "首跑体验", "创作驾驶", { tab: "create" }, v => {
  const h5 = PROTO.dev === "h5";
  let step = 0;
  const steps = [
    `<div class="player"><span class="play">▶</span><span class="watermark">预生成样片 · &lt;3s 起播</span></div><div class="kv">这是模板《逆袭》的成片效果。</div><div class="row"><span class="chip">🤖 制片人小剧：先看 20 秒，值不值得往下做你说了算</span></div>`,
    `<div class="player"><span class="play">▶</span><span class="watermark">真实试拍样 · 单镜 5s</span></div><div class="kv">这就是正式画面水平 —— 非加料、非超帧演示。</div>`,
    `<textarea placeholder="你也说一句试试：比如「外卖员觉醒系统，送单送成全城传说」" style="width:100%;min-height:90px;border:1px solid #DCD9D1;border-radius:12px;padding:12px"></textarea><div class="row" style="margin-top:8px"><button class="btn btn-ghost">🎤 语音输入</button><span class="weak">自己输入才转为真实项目</span></div>`
  ];
  const draw = () => {
    v.innerHTML = `<div class="page">
      <div class="row spread"><b>欢迎来剧场（半成品模板项目）</b><button class="btn btn-ghost" id="skip" style="padding:4px 10px;font-size:12px">跳过引导</button></div>
      <div class="steps" style="margin-top:10px">${[0, 1, 2].map(i => `<i class="${i <= step ? "on" : ""}"></i>`).join("")}</div>
      <div class="card">${steps[step]}</div>
      <div class="row" style="justify-content:space-between">
        <button class="btn btn-ghost" id="prev" ${step === 0 ? "disabled" : ""}>上一步</button>
        ${step < 2 ? `<button class="btn btn-primary" id="next">下一步</button>` : `<button class="btn btn-primary" id="turn">就它了 · 转真实项目</button>`}
      </div>
      <div class="banner info" style="margin-top:14px">📮 正式开机后：<b>正式成片约 25 分钟</b>，完成后通知你（纳期卡）</div>
    </div>`;
    v.querySelector("#next").onclick = () => { step++; draw(); };
    v.querySelector("#prev").onclick = () => { step--; draw(); };
    v.querySelector("#skip").onclick = () => T.go("S2");
    if (step < 2) v.querySelector("#prev").disabled = step === 0;
    const tn = v.querySelector("#turn"); if (tn) tn.onclick = () => { T.toast("已转为真实项目 · 剧本组开始拆策划案"); T.go("S3"); };
    T.primary = () => step < 2 ? (step++, draw()) : (T.toast("已转为真实项目"), T.go("S3"));
  };
  draw();
});

/* ================= S3 提案卡流（9 类卡）================= */
T.reg("S3", "提案卡流（9 类卡）", "创作驾驶", { tab: "create" }, v => {
  const h5 = PROTO.dev === "h5";
  let regen = { c3: 0 }, swapCount = 0;
  v.innerHTML = `<div class="stream">
    <div class="row" style="margin-bottom:10px"><span class="weak">创作驾驶 · 唯一写路径之一（与工作台共享必答卡 §1）</span><span class="grow"></span><button class="btn btn-ghost" style="font-size:12px;padding:4px 10px" onclick="T.capsule('制片组有新东西给你看 · 分镜确认卡')">模拟新卡</button></div>

    <!-- C1 策划案 -->
    <div class="pcard" data-c="c1"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🧠 阿编（悬疑向编剧）· L1① 结构化产出 · 机检通过</div>
      <div class="t">《夜航西飞》策划案</div>
      <div class="sub">民国末年的上海，女飞行员林晚与旧情人陈舟在最后一班夜航船上重逢——一个要带走密电，一个要带走她。<b>三幕压两幕</b>，钩子在 00:18。</div>
      <details class="kv" style="margin-top:8px"><summary>梗概展开（折叠）</summary>第一幕：码头交易…第二幕：船上对峙…第三幕：灯塔定格。</details>
      <div class="row wrap" style="margin-top:8px"><span class="weak">集数：</span>${[8, 12, 16, 24].map(n => `<button class="chip ${n === 12 ? "sel" : ""}" data-eps="${n}">${n} 集</button>`).join("")}<span class="weak" id="esht">→ 预估 192 镜 · 约 ¥278</span></div>
      <div class="acts"><button class="btn btn-primary" data-act="c1ok">就这个方向</button><button class="btn btn-ghost" data-act="c1edit">让它改改</button></div>
      <div class="kv hidden" data-edit><div class="row"><input class="grow" placeholder="告诉阿编怎么改，比如「第二幕再狠一点」" style="border:1px solid #DCD9D1;border-radius:8px;padding:8px"><button class="btn btn-ghost">送过去</button></div></div>
    </div>

    <!-- C2 演员表 -->
    <div class="pcard" data-c="c2"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🎭 选角导演 · L1② 抽取＋生图（自部署·标准档）</div>
      <div class="t">演员表 · 2 位主演等你签约</div>
      <div data-role="林晚"><div class="row spread"><b>林晚</b><span class="weak">女主 · 飞行员</span></div><div class="imgs">${[1, 2, 3, 4].map(i => T.ph("候选 " + i, { grade: i === 2 ? "hi" : i === 1 ? "mid" : "lo", pick: `T.toast('林晚 · 已定妆（锚点图已锁定）')` })).join("")}</div>
        <div class="row"><button class="btn btn-ghost" data-swap="林晚">🔄 换一个</button><button class="btn btn-ghost" data-face>看外貌字段</button><span class="weak" data-swapn></span></div></div>
      <div data-role="陈舟" style="margin-top:10px"><div class="row spread"><b>陈舟</b><span class="weak">男主 · 报务员</span></div><div class="imgs">${[1, 2, 3, 4].map(i => T.ph("候选 " + i, { grade: i === 3 ? "hi" : "mid", pick: `T.toast('陈舟 · 已定妆')` })).join("")}</div>
        <div class="row"><button class="btn btn-ghost" data-swap="陈舟">🔄 换一个</button><button class="btn btn-ghost" data-face>看外貌字段</button></div></div>
      <div class="acts"><button class="btn btn-primary" data-act="c2ok">全员签约</button><button class="btn btn-ghost" data-act="c2deep">去选角页深挖</button></div>
    </div>

    <!-- C3 美术 -->
    <div class="pcard" data-c="c3"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🎨 美术指导 · L1③ 风格推导</div>
      <div class="t">美术方案 · 民国 noir · 冷雨暖灯</div>
      <div class="imgs" style="grid-template-columns:repeat(3,1fr)">${T.ph("雨夜码头", { cls: "w11" })}${T.ph("夜航船舱", { cls: "w11" })}${T.ph("灯塔顶层", { cls: "w11" })}</div>
      <div class="row wrap">${["冷雨暖灯", "高对比剪影", "青橙分级"].map((c, i) => `<button class="chip ${i < 2 ? "sel" : ""}">${c}</button>`).join("")}<span class="weak" id="c3n"></span></div>
      <div class="acts"><button class="btn btn-primary" data-act="c3ok">就这么拍</button><button class="btn btn-ghost" data-act="c3tune">调风格</button></div>
    </div>

    <!-- C4 分镜确认 -->
    <div class="pcard" data-c="c4"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🎬 分镜师 · L1④ 镜头表（机检：时长合计 ✓ 引用完整 ✓）</div>
      <div class="t">场次 2《雨夜码头》16 镜 · 合计 60s</div>
      <div class="shotstrip">${PROTO.shots.map(s => `<div class="sq"><b>#${s.id}</b><i>${s.sec}s</i></div>`).join("")}</div>
      <div class="acts"><button class="btn btn-primary" data-act="c4ok">出样片</button><button class="btn btn-ghost" data-act="c4grid">逐格看看 →</button></div>
    </div>

    <!-- C5 样片 -->
    <div class="pcard" data-c="c5"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🎞 制片组 · FFmpeg+TTS+配乐 合成</div>
      <div class="t">E01 样片（60s · 非正式画面）</div>
      <div class="player"><span class="play">▶</span><span class="watermark">非正式画面 · 分镜图+配音粗剪</span></div>
      <div class="card" style="margin:10px 0 0;padding:10px"><div class="row"><div class="ph w169" style="width:96px"></div><div class="grow"><b style="font-size:13px">真实试拍样（单镜 5s）</b><div class="weak">这就是正式画面水平</div></div><button class="btn btn-ghost" style="font-size:12px;padding:4px 10px">▶</button></div></div>
      <div class="acts"><button class="btn btn-primary" data-act="c5go">开机 🎬</button><button class="btn btn-ghost" data-act="c5tune">先改改节奏</button></div>
    </div>

    <!-- C6 预算报价 -->
    <div class="pcard" data-c="c6"><span class="info-i" data-info>ⓘ</span>
      <div class="who">📋 制片主任 · L1⑥ 预估（难度标签＋历史版本）</div>
      <div class="t">预算报价 · 开机前必答</div>
      <div class="kv"><details><summary>分档明细（自部署档）</summary><div class="lrow"><span>标准档 ×12 镜</span><b class="num">¥9.6</b></div><div class="lrow"><span>高价值档 ×3 镜</span><b class="num">¥6.9</b></div><div class="lrow"><span>夜间闲时 ×1 镜</span><b class="num">¥1.1</b></div><div class="lrow"><span>TTS+配乐</span><b class="num">¥0.8</b></div></details></div>
      <div class="row spread" style="margin-top:8px"><b class="num">总估 ¥18.4 · 约 24 分钟</b><span class="weak">预算 ¥50 内 ✓</span></div>
      <div class="acts"><button class="btn btn-primary" data-act="c6go">确认开跑</button><button class="btn btn-ghost" data-act="c6save">省着拍</button></div>
    </div>

    <!-- C7 审片 -->
    <div class="pcard" data-c="c7"><span class="info-i" data-info>ⓘ</span>
      <div class="who">✂️ 后期组（规则码）· 含机审通过回执</div>
      <div class="t">E01 成片等你验收</div>
      <div class="player" style="max-height:240px"><span class="play">▶</span><span class="watermark">含重拍记录 3 次</span></div>
      <div class="shotstrip" style="margin-top:8px">${PROTO.shots.map(s => `<div class="sq ${s.st === "redo" ? "" : ""}"><b>#${s.id}</b>${s.st === "redo" ? '<span class="tk tk-warn" style="position:absolute;bottom:2px;left:4px;font-size:9px;padding:0 4px">需重做</span>' : ""}<i>${s.sec}s</i></div>`).join("")}</div>
      <div class="acts"><button class="btn btn-primary" data-act="c7ok">验收</button><button class="btn btn-ghost" data-act="c7redo">重拍第 6 镜</button></div>
    </div>

    <!-- C9 配乐提案（配乐标准版 · 第 9 类卡 · 非必答门，可整体关） -->
    <div class="pcard" data-c="c9"><span class="info-i" data-info>ⓘ</span>
      <div class="who">🎵 制片组 · 自动配乐（生成节点非问答 · 项目设置可整体关）</div>
      <div class="t">配乐提案 · 场 2 / 场 4 各 3 条候选</div>
      <div class="lrow"><span><b>场2·离别</b>《码头暮色》 52s</span><span class="row" style="gap:6px"><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" data-mpl="码头暮色">▶ 试听</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" data-muse="码头暮色">用这条</button></span></div>
      <div class="lrow"><span><b>场4·释然</b>《晚风》 38s</span><span class="row" style="gap:6px"><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" data-mpl="晚风">▶ 试听</button><button class="btn btn-ghost" style="font-size:11px;padding:2px 10px" data-muse="晚风">用这条</button></span></div>
      <div class="lrow"><span><b>场4·释然</b>备选生成中</span><span id="c9tk"></span></div>
      <div class="acts"><button class="btn btn-ghost" data-act="c9swap">🔄 换一批</button><span class="weak">影子成本 ¥0.10/条 · 不拦用户 · 入库见「项目 → 资产 → 音乐库」</span></div>
    </div>

    <!-- C8 验收 -->
    <div class="pcard" data-c="c8"><span class="info-i" data-info>ⓘ</span>
      <div class="who">📦 交付组（规则码）</div>
      <div class="t">验收 · 标识核对</div>
      <ul class="check"><li><span class="g">✓</span>1080×1920 · 30fps</li><li><span class="g">✓</span>显式标识：片头 2s + 角标</li><li><span class="g">✓</span>隐式标识已写入</li><li><span class="g">✓</span>字幕安全区</li></ul>
      <div class="acts"><button class="btn btn-primary" data-act="c8ex">导出 →</button><button class="btn btn-ghost" data-act="c8back">回后期</button></div>
    </div>
  </div>`;

  /* 交互绑定 */
  v.querySelectorAll("[data-info]").forEach(b => b.onclick = () => {
    const c = b.closest(".pcard"); let kv = c.querySelector("[data-evidence]");
    if (!kv) { kv = document.createElement("div"); kv.className = "kv"; kv.dataset.evidence = "1"; kv.innerHTML = "👤 谁做的：阿编（persona v3）　⏱ 用了多久：42s　💰 花了多少：¥0.03"; c.appendChild(kv); } else kv.remove();
  });
  v.querySelectorAll("[data-eps]").forEach(b => b.onclick = () => {
    v.querySelectorAll("[data-eps]").forEach(x => x.classList.remove("sel")); b.classList.add("sel");
    const n = +b.dataset.eps; v.querySelector("#esht").textContent = `→ 预估 ${n * 16} 镜 · 约 ¥${(n * 23.2).toFixed(0)}`;
  });
  v.querySelector("[data-act=c1edit]").onclick = () => v.querySelector("[data-edit]").classList.toggle("hidden");
  v.querySelector("[data-act=c1ok]").onclick = () => { T.dec(1); T.toast("方向已锁定，选角导演开工了"); };
  v.querySelectorAll("[data-swap]").forEach(b => b.onclick = () => {
    const imgs = b.closest("[data-role]").querySelectorAll(".ph");
    imgs.forEach(p => p.classList.add("dim")); swapCount++;
    setTimeout(() => imgs.forEach((p, i) => { p.classList.remove("dim"); p.style.background = `linear-gradient(135deg,hsl(${Math.random() * 360},30%,78%),hsl(${Math.random() * 360},35%,66%))`; }), 650);
    const n = b.closest("[data-role]").querySelector("[data-swapn]"); if (n) n.textContent = `已换 ${swapCount} 次（8 次建议去选角页深挖）`;
    if (swapCount >= 8) T.capsule("建议：转选角页深挖（连续 8 次「换一个」）", () => T.go("S6"));
  });
  v.querySelectorAll("[data-face]").forEach(b => b.onclick = () => T.sheet("外貌字段", `<div class="lrow"><span>发型</span><span class="tag">低髻 · 微湿</span></div><div class="lrow"><span>服装</span><span class="tag">皮质飞行夹克</span></div><div class="lrow"><span>气质关键词</span><span class="tag">克制 · 倦而锋利</span></div>`, [{ label: "按修改重出一批", kind: "btn-primary", onClick: c => { c(); T.toast("已提交生图队列（免费额度内）"); } }]));
  v.querySelector("[data-act=c2ok]").onclick = () => T.confirm({ title: "全员签约", summary: "签约即锁定两位主演定妆照为<b>全剧锚点</b>，后续镜头以此为一致性基准。", time: "即时", cost: "¥0", shots: "影响全剧 192 镜", okLabel: "全员签约", onOk: () => T.toast("演员表已锁定 ✓") });
  v.querySelector("[data-act=c2deep]").onclick = () => T.go("S6");
  v.querySelector("[data-act=c3tune]").onclick = () => {
    if (regen.c3 >= 6) { T.toast("本会话预览已达 6 次，后续重生成将排队", () => { }); return; }
    regen.c3++; v.querySelector("#c3n").textContent = `预览重生成 ${regen.c3}/6`;
    const im = v.querySelectorAll("[data-c=c3] .ph")[2]; im.classList.add("skel"); setTimeout(() => im.classList.remove("skel"), 800);
  };
  v.querySelector("[data-act=c3ok]").onclick = () => { T.dec(1); T.toast("美术包已锁定（解锁需确认+留痕）"); };
  v.querySelector("[data-act=c4ok]").onclick = () => { T.dec(1); T.toast("样片合成中…约 40s"); setTimeout(() => T.go("S9"), 900); };
  v.querySelector("[data-act=c4grid]").onclick = () => T.go("S8");
  v.querySelector("[data-act=c5go]").onclick = () => T.confirm({ title: "开机确认", summary: "16 镜批量开拍，全部走自部署档。", time: "预计 24 分钟", cost: "约 ¥18.4", shots: "拍 16 镜", onOk: () => T.go("S10") });
  v.querySelector("[data-act=c5tune]").onclick = () => T.go("S8");
  v.querySelector("[data-act=c6go]").onclick = () => T.confirm({ title: "开机确认（预算报价）", summary: "确认后任务入队，超预算 20% 会自动暂停等你。", time: "预计 24 分钟", cost: "总估 ¥18.4", shots: "拍 16 镜", onOk: () => T.go("S10") });
  v.querySelector("[data-act=c6save]").onclick = () => T.toast("已降档预览：省 34%（3 镜高价值→标准），画质影响见明细");
  v.querySelector("[data-act=c7ok]").onclick = () => { T.dec(1); T.go("S12"); };
  v.querySelector("[data-act=c7redo]").onclick = () => T.go("S10");
  v.querySelector("[data-act=c8ex]").onclick = () => T.go("S12");
  v.querySelector("[data-act=c8back]").onclick = () => T.go("S11");
  const c9tk = () => { const n = v.querySelector("#c9tk"); if (n) n.innerHTML = T.tk("q"); };
  c9tk();
  v.querySelectorAll("[data-mpl]").forEach(b => b.onclick = () => T.toast(`▶ 试听《${b.dataset.mpl}》· 与 S9 音轨条同源播放`));
  v.querySelectorAll("[data-muse]").forEach(b => b.onclick = () => {
    if (b.dataset.muse === "码头暮色") T.sheet("该曲产物使用权标记缺失", `<div class="kv">「用这条」后将在 S12 交付预检被拦截（双许可纪律）。可先挂接占位，导出前换许可曲或补标记。</div>`, [{ label: "仍挂接（预检会拦）", kind: "btn-danger", onClick: c => { c(); T.toast("已挂接场2 · S12 预检将提示") } }, { label: "换许可曲", onClick: c => { c(); T.toast("已改用库内已许可候选《晚风》") } }]);
    else T.toast(`《${b.dataset.muse}》已入库并挂到该场音轨 · 双许可齐 ✓`);
  });
  v.querySelector("[data-act=c9swap]").onclick = () => {
    c9tk(); T.toast("已提交重出 3 条候选 · 约 40s（影子成本照常入账）");
  };
  T.primary = () => { const b = v.querySelector("[data-act=c1ok]"); b && b.click(); };
});
