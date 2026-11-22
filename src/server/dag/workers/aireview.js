"use strict";
/**
 * workers/aireview.js — 卡流节点 AI 审查（拍板点自动机检，2026-11-21）
 *
 * 用户诉求：每个拍板节点都要有 AI 以不同人格视角参与检查，审当前提交的节点内容。
 * 一期自部署无 LLM 通道（L2 现为规则式 dsh-stub）——本 worker 是诚实实现：
 *   多人格 = 结构化的视角分工（编剧/观众/制片/选角导演/摄影/统筹），
 *   每条 findings 都是真实规则检查的结果，绝不虚构「模型意见」；engine 标注「规则机检」。
 * 真 LLM（DSH/llm-gw）到位后：同 lane 换 prompt 驱动实现，人格骨架与卡片渲染不变。
 *
 * 纪律：确定性（禁随机）；free（机检不收影子成本）；只读 state，不改任何创作数据。
 * 产出：{ personas:[{persona, verdict: pass|warn|fail, findings:[…]}], verdict, engine }
 */
const fs = require("fs");
const path = require("path");
const prompts = require("../../prompts/index.js");

const NAME = "aireview";
const ENGINE = "规则机检（多人格视角）";

/* ---------------- 公共读取 ---------------- */

function safeJoin(base, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(process.cwd(), a);
}

function readCtx(ctx, episodeId) {
  const st = ctx.store.get();
  const ep = (st.episodes || {})[episodeId] || {};
  const scenes = Object.keys(st.scenes || {}).map((k) => st.scenes[k])
    .filter((s) => s.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const shots = Object.keys(st.shots || {}).map((k) => st.shots[k])
    .filter((s) => s.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return { st, ep, scenes, shots };
}

function flatShots(payload) {
  const out = [];
  (payload.scenes || []).forEach((sc, si) => {
    (sc.shots || []).forEach((sh, i) => out.push({ si, i, sc, sh }));
  });
  return out;
}

const WORST = { pass: 0, warn: 1, fail: 2 };
function combine(verdicts) {
  return verdicts.map((v) => (v === "info" ? "pass" : v)).reduce((a, v) => (WORST[v] > WORST[a] ? v : a), "pass");
}
function mk(persona, verdict, findings) {
  return { persona, verdict, findings: findings.filter(Boolean) };
}
function verdictOf(findings) {
  return combine(findings.map((x) => String(x).split("：")[0]));
}

/* ---------------- C1 故事方向 ---------------- */

function reviewC1(ctx, card, episodeId) {
  const p = card.payload || {};
  const { ep } = readCtx(ctx, episodeId);
  const shots = flatShots(p);
  const out = [];

  // 编剧视角：文本完整性
  {
    const f = [];
    const noDesc = shots.filter((x) => !String(x.sh.desc || "").trim());
    if (noDesc.length) f.push("fail：" + noDesc.length + " 镜没有画面描述（镜位 " + noDesc.map((x) => "场" + (x.si + 1) + "镜" + (x.i + 1)).join("、") + "）");
    else f.push("pass：全部 " + shots.length + " 镜都有画面描述");
    const dlgNoCast = shots.filter((x) => String(x.sh.dialogue || "").trim() && !(x.sh.cast || []).length);
    if (dlgNoCast.length) f.push("fail：" + dlgNoCast.length + " 镜有台词但没标说话角色（台词无法配音）");
    const noMood = (p.scenes || []).filter((sc) => !String(sc.mood || "").trim());
    if (noMood.length) f.push("warn：" + noMood.length + " 场缺情绪基调（影响场景光照映射）");
    const dlgShots = shots.filter((x) => String(x.sh.dialogue || "").trim()).length;
    const ratio = shots.length ? Math.round((dlgShots / shots.length) * 100) : 0;
    if (shots.length && dlgShots === 0) f.push("warn：全片没有一句台词（无声剧？确认是否有意）");
    else if (ratio < 25) f.push("info：台词镜占比 " + ratio + "%，台词偏少——短剧习惯高密度对白");
    else f.push("pass：台词镜占比 " + ratio + "%");
    const fast = shots.filter((x) => {
      const d = String(x.sh.dialogue || "").replace(/[^一-龥A-Za-z0-9，。！？、：；"'s]/g, "");
      const chars = d.replace(/[s，。！？、：；"']/g, "").length;
      const sec = Number(x.sh.sec) || 5;
      return chars > 0 && chars > sec * 5;
    });
    if (fast.length) {
      f.push("warn：" + fast.length + " 镜台词超出语速容量（中文≈5字/秒）——口型/speech 生成会截断，建议加秒数或删词");
    } else if (shots.some((x) => String(x.sh.dialogue || "").trim())) {
      f.push("pass：台词量均在语速容量内");
    }
        const last = shots[shots.length - 1];
    if (last && !String(last.sh.dialogue || "").trim()) f.push("info：结尾镜无台词——靠画面收束，确认是否留得住悬念");
    out.push(mk("编剧视角", verdictOf(f), f));
  }

  // 观众视角：节奏与钩子
  {
    const f = [];
    const secs = shots.map((x) => Number(x.sh.sec) || 5);
    const total = secs.reduce((a, b) => a + b, 0);
    f.push("info：成片约 " + total + " 秒（" + shots.length + " 镜）");
    const uniq = Array.from(new Set(secs));
    if (secs.length > 3 && uniq.length === 1) f.push("warn：所有镜头都是 " + secs[0] + " 秒——节奏单一，建议长短镜交错");
    const first = shots[0];
    if (first && (String(first.sh.dialogue || "").trim() || (first.sh.cast || []).length)) {
      f.push("pass：开场镜有角色/台词，进戏快");
    } else {
      f.push("warn：开场镜是纯空镜——短剧前 3 秒要有钩子，建议开篇即人物或事件");
    }
    out.push(mk("观众视角", verdictOf(f), f));
  }

  // 网感编辑视角（2026-11-22 对标调研梯队③）：短剧钩子/爽点密度——行业标配审计维度
  //（分集钩子表/集尾钩子/爽点密度是短剧编剧工具的通用口径；规则词表可随运营复盘迭代）
  {
    const f = [];
    // ① 集尾钩子：末镜有台词或悬念词 → 留得住；否则 warn
    const last = shots[shots.length - 1];
    const hookWords = /(悬念|突然|竟然|到底|身份|真面|转身|出现|跪|求|夺|威胁|真相|没想到|下一秒|回头|亮出|报上|震惊)/;
    const lastText = last ? String(last.sh.dialogue || "") + String(last.sh.desc || "") : "";
    if (lastText.trim().length === 0) f.push("warn：结尾镜是空的——集尾必须留钩子（台词/事件/悬念画面）");
    else if (hookWords.test(lastText) || String(last.sh.dialogue || "").trim()) f.push("pass：集尾有钩子（台词/悬念词命中）");
    else f.push("warn：结尾镜无台词且无悬念词——划走风险高，建议补一句吊钩台词或反转画面");
    // ② 爽点密度：全片钩子词按分钟计（行业经验 ≥3 个/分钟为产能型短剧常见密度）
    const allText = shots.map((x) => String(x.sh.dialogue || "") + " " + String(x.sh.desc || "")).join(" ");
    const hits = (allText.match(new RegExp(hookWords.source, "g")) || []).length;
    const totalSec = shots.reduce((a, b) => a + (Number(b.sh.sec) || 5), 0);
    const perMin = totalSec > 0 ? (hits / (totalSec / 60)) : 0;
    if (perMin >= 3) f.push("pass：爽点密度 " + perMin.toFixed(1) + " 个/分钟（" + hits + " 处钩子词）");
    else if (perMin >= 1) f.push("info：爽点密度 " + perMin.toFixed(1) + " 个/分钟——产能型短剧常见 3+/分钟，可再加密");
    else f.push("warn：爽点密度 " + perMin.toFixed(1) + " 个/分钟——偏文艺向，投流素材跑量建议加冲突/反转");
    // ③ 前 3 镜进戏：至少 2 镜有台词或人物
    const first3 = shots.slice(0, 3);
    const inDrama = first3.filter((x) => String(x.sh.dialogue || "").trim() || (x.sh.cast || []).length).length;
    if (first3.length >= 3 && inDrama < 2) f.push("warn：前 3 镜仅 " + inDrama + " 镜进戏（台词/人物）——短剧前 10 秒定生死");
    else if (first3.length) f.push("pass：前 3 镜 " + inDrama + "/3 镜进戏");
    out.push(mk("网感编辑视角", verdictOf(f), f));
  }

  // 制片视角：成本与保脸前置条件
  {
    const f = [];
    const cast = p.cast || [];
    const noRef = cast.filter((c) => !c.refImage);
    if (cast.length && noRef.length) {
      f.push("warn：" + noRef.map((c) => c.role).join("、") + " 没有参考图——定妆纯靠文字锚定，多镜保脸弱（建议 C2 前补图）");
    } else if (cast.length) {
      f.push("pass：全部角色有参考图，定妆保脸有锚");
    }
    const estCents = shots.length * 80 + cast.length * 30;
    const budget = Number(ep.budget_cents) || 0;
    if (budget > 0) {
      const pct = Math.round((estCents / budget) * 100);
      f.push("info：粗估拍摄成本 " + estCents + " 分 ≈ 预算 " + budget + " 分的 " + pct + "%");
      if (pct > 100) f.push("fail：粗估已超预算，进入制作前要压缩镜数或提高预算");
      else if (pct > 80) f.push("warn：粗估占用预算超 80%，注意后续重拍余量");
    }
    out.push(mk("制片视角", verdictOf(f), f));
  }

  return out;
}

/* ---------------- C2 选角/定妆 ---------------- */

function reviewC2(ctx, card, episodeId) {
  const p = card.payload || {};
  const { shots } = readCtx(ctx, episodeId);
  const out = [];

  // 选角导演视角
  {
    const f = [];
    const actors = p.actors || [];
    const missing = actors.filter((a) => !((a.candidates || [])[0] || {}).art);
    if (!actors.length) f.push("fail：本卡没有角色定义");
    else if (missing.length) f.push("warn：" + missing.map((a) => a.role).join("、") + " 定妆还没出来（生成中）");
    else f.push("pass：全部 " + actors.length + " 位角色定妆已落卡");
    out.push(mk("选角导演视角", verdictOf(f), f));
  }

  // 造型师视角：锚点完备性
  {
    const f = [];
    const st = ctx.store.get();
    const cast = (((st.episodes || {})[episodeId] || {}).script || {}).cast || [];
    const noAnchor = cast.filter((c) => !String(c.anchor || "").trim());
    if (cast.length && noAnchor.length) f.push("warn：" + noAnchor.map((c) => c.role).join("、") + " 缺外形锚点（anchor）——视频提示词保脸弱");
    else if (cast.length) f.push("pass：全部角色有外形锚点＋服装锁");
    out.push(mk("造型师视角", verdictOf(f), f));
  }

  // 分镜覆盖
  {
    const f = [];
    const imgs = p.images || [];
    const miss = shots.length - imgs.filter((im) => im.art).length;
    if (miss > 0) f.push("warn：分镜首帧还差 " + miss + " 镜（" + shots.length + " 镜全齐才可进样片）");
    else f.push("pass：分镜首帧 " + imgs.length + "/" + shots.length + " 镜齐");
    out.push(mk("统筹视角", verdictOf(f), f));
  }

  return out;
}

/* ---------------- C4 样片/分镜画面 ---------------- */

function reviewC4(ctx, card, episodeId) {
  const p = card.payload || {};
  const { st } = readCtx(ctx, episodeId);
  const base = String((ctx.cfg && ctx.cfg.outDir) || path.join("var", "out"));
  const out = [];

  // 摄影师视角：分镜图落盘
  {
    const f = [];
    const imgs = p.images || [];
    if (!imgs.length) f.push("fail：本卡没有分镜图");
    let onDisk = 0;
    imgs.forEach((im) => { if (im.art && fs.existsSync(safeJoin(base, im.art))) onDisk += 1; });
    if (imgs.length && onDisk < imgs.length) f.push("fail：" + (imgs.length - onDisk) + " 张分镜图文件缺失（卡片有引用、盘上没有）");
    else if (imgs.length) f.push("pass：" + onDisk + " 张分镜图全部落盘");
    out.push(mk("摄影师视角", verdictOf(f), f));
  }

  // 配音导演视角：台词产物对齐
  {
    const f = [];
    const lines = (st.voice_lines || {})[episodeId] || [];
    const dlg = [];
    ( (((st.episodes || {})[episodeId] || {}).script || {}).scenes || []).forEach((sc, si) =>
      (sc.shots || []).forEach((sh, i) => { if (String(sh.dialogue || "").trim()) dlg.push({ seq: (si + 1) * 100 + i + 1, text: sh.dialogue }); }));
    const missing = dlg.filter((d) => !lines.some((l) => l.text === d.text && l.art));
    if (dlg.length && missing.length) f.push("warn：" + missing.length + "/" + dlg.length + " 句台词还没有语音产物（配音生成中或失败）");
    else if (dlg.length) f.push("pass：" + dlg.length + " 句台词语音全部就位");
    else f.push("info：本剧无台词镜（纯画面＋BGM）");
    out.push(mk("配音导演视角", verdictOf(f), f));
  }

  return out;
}

/* ---------------- C6 开机报价 ---------------- */

function reviewC6(ctx, card, episodeId) {
  const p = card.payload || {};
  const { ep, shots } = readCtx(ctx, episodeId);
  const out = [];

  // 制片视角：预算红线
  {
    const f = [];
    const est = p.estimate || {};
    const budget = Number(ep.budget_cents) || 0;
    if (budget > 0 && est.cents != null) {
      const pct = Math.round((est.cents / budget) * 100);
      f.push("info：报价 " + est.cents + " 分 ≈ 预算的 " + pct + "%");
      if (pct > 100) f.push("fail：报价超预算——要么砍镜数，要么提预算");
      else if (pct > 80) f.push("warn：报价占预算超 80%——重拍余量吃紧");
      else f.push("pass：报价在预算内，留有重拍余量");
    } else f.push("warn：缺预算或报价数据，红线无法核对");
    out.push(mk("制片视角", verdictOf(f), f));
  }

  // 统筹视角：口径一致性
  {
    const f = [];
    const est = p.estimate || {};
    if (est.shots != null && shots.length && Number(est.shots) !== shots.length) {
      f.push("fail：报价镜数 " + est.shots + " 与镜库 " + shots.length + " 不一致（剧本改动后未重新估价？）");
    } else f.push("pass：报价镜数与镜库一致（" + shots.length + " 镜）");
    if (est.time_min != null) f.push("info：预计耗时约 " + est.time_min + " 分钟");
    out.push(mk("统筹视角", verdictOf(f), f));
  }

  return out;
}

/* ---------------- LLM 人格叠加（fail-open：LLM 离线/超时 → 只出规则结果） ---------------- */

const LLM_PERSONA_NAMES = {
  C1: ["编剧视角", "观众视角", "网感编辑视角", "制片视角"],
  C2: ["选角导演视角", "造型师视角", "统筹视角"],
  C4: ["摄影师视角", "配音导演视角"],
  C6: ["制片视角", "统筹视角"]
};

async function llmReviewPersonas(ctx, card, rulePersonas) {
  if (!ctx.llm || typeof ctx.llm.chat !== "function" || !ctx.llm.enabled()) return null;
  const names = LLM_PERSONA_NAMES[card.type] || [];
  if (!names.length) return null;
  // 提示词迁入注册中心（2026-11-22 方案 §5.8/A12）：按卡类型 rubric 化（与规则机检维度对齐），
  // payload 经 q() 定界（用户数据非指令，收窄注入面）
  const sys = prompts.buildAireviewSys(card.type, names);
  // 设定域注入（素材中心 C1，2026-11-22）：canon.reject_rules（判废表）随 sys 注入——
  // 行业口径：判废标准是库资产，AI 审查与人工复审共读同一份。
  // 2026-11-23 加项目作用域（灯塔事故防线）：只注入绑定本集所属项目的判废条目，未绑定不生效。
  try {
    const st = ctx.store.get();
    const ep = (st.episodes || {})[card.episodeId] || {};
    const pid = ep.projectId ? String(ep.projectId) : "";
    const rules = st && st.asset_lib && st.asset_lib.canon && Array.isArray(st.asset_lib.canon.reject_rules) ? st.asset_lib.canon.reject_rules : [];
    const lines = pid ? rules
      .filter((r) => r && (r.title || r.content) && String(r.projectId || "") === pid)
      .map((r, i) => (i + 1) + ". " + (r.title || "判废") + "：" + (r.content || ""))
      .slice(0, 12) : [];
    if (lines.length) sys += "\n\n判废表（命中任一条即至少 warn，明显违规给 fail）：\n" + lines.join("\n");
  } catch (e) { /* 判废注入失败不阻断审查 */ }
  const usr = prompts.buildAireviewUsr(card.payload);
  const r = await ctx.llm.chat(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    { temperature: 0.3, maxTokens: 900, timeoutMs: 30000 }
  );
  if (!r.ok || !r.content) return null;
  const m = String(r.content).match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  arr.forEach(function (x) {
    if (!x || typeof x !== "object") return;
    const name = String(x.persona || "");
    if (names.indexOf(name) < 0) return;
    const verdict = ["pass", "warn", "fail"].indexOf(x.verdict) >= 0 ? x.verdict : "warn";
    const findings = Array.isArray(x.findings) ? x.findings
      .filter(function (f) { return typeof f === "string" && f.trim(); })
      .map(function (f) { return String(f).trim().slice(0, 160); })
      .slice(0, 5) : [];
    if (findings.length) out.push({ persona: name, verdict: verdict, findings: findings, llm: true });
  });
  return out.length ? out : null;
}

/* ---------------- worker 入口 ---------------- */

const REVIEWERS = {
  C1: [{ fn: reviewC1 }],
  C2: [{ fn: reviewC2 }],
  C4: [{ fn: reviewC4 }],
  C6: [{ fn: reviewC6 }]
};

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const cardId = p.cardId;
  const episodeId = p.episodeId || (j.opts && j.opts.episodeId) || null;
  const st = ctx.store.get();
  const card = (st.cards || {})[cardId];
  if (!card || !episodeId) throw Object.assign(new Error("aireview 缺 card/episode"), { code: "BAD_JOB" });

  const spec = REVIEWERS[card.type];
  let personas = spec ? spec.flatMap((s) => s.fn(ctx, card, episodeId)) : [];
  // LLM 叠加：同人格追加 llm_findings/llm_verdict；不可达 → 只出规则结果（诚实标注跟随实际引擎）
  let engineLabel = ENGINE;
  let llmUsed = false;
  try {
    const llmP = await llmReviewPersonas(ctx, card, personas);
    if (llmP && llmP.length) {
      personas = personas.map((rule) => {
        const m = llmP.find((x) => x.persona === rule.persona);
        return m ? Object.assign({}, rule, { llm_verdict: m.verdict, llm_findings: m.findings }) : rule;
      });
      engineLabel = "LLM 审查＋规则机检·" + (ctx.llm.label ? ctx.llm.label() : "");
      llmUsed = true;
    }
  } catch (e) { /* fail-open */ }
  const verdict = combine(personas.map((x) => x.verdict));
  const meta = {
    kind: "ai-review", // 诚实标注：ai-review-rules（纯规则）| ai-review（含 LLM 叠加）
    lane: NAME, engine: engineLabel, llm_used: llmUsed, episodeId, cardId, cardType: card.type,
    personas: personas.length, verdict
  };
  const result = { ok: true, cents: 0, engine: engineLabel, llm_used: llmUsed, cardId, cardType: card.type, verdict, personas, meta };
  j.result = result;
  j.art = result;
  return result;
}

module.exports = { name: NAME, lane: NAME, run };
