"use strict";
/**
 * api/templates.js — 题材节拍模板注册表（2026-11-21 补全 FR-1001 最小闭环＋FR-203 首批 ≥5）
 *
 * 模板＝题材节拍器（beats）＋风格预设（style→project.style_pkg）＋brief 骨架＋成片 demo 位。
 * 用途：首页「模板流」与「一句话成片/小说改编」一站式直跑（POST /api/quickstart，episodes.js）——
 *   模板节拍作为 scriptgen（一句话→结构化剧本）的展开骨架，风格预设落到项目 style_pkg。
 * 存储：state.templates（惰性种子，仿 ensureNodes）；运营可增改停用（FR-1304），
 *   版本 ver 只增不减（NFR-08 模板版本化），删除需二次确认（CONFIRM_REQ）。
 * 内置 6 款（逆袭/甜宠/悬疑/带货/古风/都市），demo.url 预留——当前占位画面由前端渲染。
 */

const SEED_TEMPLATES = [
  {
    id: "tpl_nixi",
    name: "逆袭 · 战神归来",
    genre: "逆袭",
    desc: "开局被踩到底，两次反转连续打脸——身份揭晓的钩子留在中段。",
    beats: [
      { beat: "开局被踩", guide: "主角被打到底，憋屈拉满，给观众一个必须看下去的理由" },
      { beat: "金手指降临", guide: "身份/系统揭晓，第一个反转钩子" },
      { beat: "首次打脸", guide: "小反派当垫脚石，第一个爽点" },
      { beat: "危机升级", guide: "大反派登场，情绪压回谷底" },
      { beat: "终局碾压", guide: "身份揭晓全场跪，第二爽点收尾" }
    ],
    style: { look: "写实电影感", palette: "青橙", ratio: "9:16" },
    brief_skeleton: "主角被所有人看扁，直到那个隐藏身份被揭开——",
    demo: { url: null, dur_sec: 48 }
  },
  {
    id: "tpl_tianchong",
    name: "甜宠 · 三次约会",
    genre: "甜宠",
    desc: "误会开局、心动中段、告白收尾，全程高糖低虐。",
    beats: [
      { beat: "初遇误会", guide: "一场乌龙让两人结下梁子，欢喜冤家开局" },
      { beat: "心动瞬间", guide: "一次意外照顾/挺身而出，眼神先于台词心动" },
      { beat: "误会升级", guide: "第三方搅局或旧照片误会，情绪小低谷" },
      { beat: "深情告白", guide: "雨夜/天台名场面，台词点题" },
      { beat: "甜宠收尾", guide: "牵手定情，糖分封顶" }
    ],
    style: { look: "柔光唯美", palette: "暖橘", ratio: "9:16" },
    brief_skeleton: "一场乌龙相遇之后，两个嘴硬的人开始互相试探——",
    demo: { url: null, dur_sec: 52 }
  },
  {
    id: "tpl_xuanyi",
    name: "悬疑 · 电梯停电",
    genre: "悬疑",
    desc: "密闭空间＋信息碎片，每场留一个异常，结尾反转余悚。",
    beats: [
      { beat: "密闭开局", guide: "封闭空间+一群各怀心事的人，交代规则" },
      { beat: "第一个异常", guide: "细小不对劲（多了一人/少了一件），悬念立起" },
      { beat: "真相碎片", guide: "线索逐片给出，互相怀疑" },
      { beat: "反转揭底", guide: "身份/动机反转，前文细节全对上" },
      { beat: "余悚收尾", guide: "最后一镜留一个开放性不安" }
    ],
    style: { look: "冷冽悬疑", palette: "冷蓝", ratio: "9:16" },
    brief_skeleton: "停电的电梯里困着六个人，但监控里显示只有五个——",
    demo: { url: null, dur_sec: 45 }
  },
  {
    id: "tpl_daihuo",
    name: "带货 · 好物种草",
    genre: "带货",
    desc: "痛点开场、效果对比、信任背书、行动召唤，15/30s 信息流节奏。",
    beats: [
      { beat: "痛点开场", guide: "前 3 秒拍痛点场景，让目标用户对号入座" },
      { beat: "产品登场", guide: "产品以解决方案身份切入，特写卖点" },
      { beat: "效果对比", guide: "使用前后对比，视觉冲击" },
      { beat: "信任背书", guide: "数据/资质/真人证言一句带过" },
      { beat: "行动召唤", guide: "限时利益点＋明确指令（点击/下单）" }
    ],
    style: { look: "写实电影感", palette: "高饱和", ratio: "9:16" },
    brief_skeleton: "还在为____烦恼？这条视频给解决办法——",
    demo: { url: null, dur_sec: 30 }
  },
  {
    id: "tpl_gufeng",
    name: "古风 · 权谋夜宴",
    genre: "古风",
    desc: "一场夜宴三重杀机，台词交锋即刀光。",
    beats: [
      { beat: "宴设鸿门", guide: "宾主落座，一杯酒一句试探，暗流铺开" },
      { beat: "暗流交锋", guide: "席间对话处处机锋，各方底牌半遮半掩" },
      { beat: "杀机四伏", guide: "图穷匕见，局势急转直下" },
      { beat: "绝地反击", guide: "主角亮出后手，一锤定音" },
      { beat: "尘埃落定", guide: "胜者不动声色，败者退出席间" }
    ],
    style: { look: "写实电影感", palette: "黛金", ratio: "9:16" },
    brief_skeleton: "宫宴之上，人人带笑赴局，唯有他知道今晚要死谁——",
    demo: { url: null, dur_sec: 55 }
  },
  {
    id: "tpl_dushi",
    name: "都市 · 烟火温情",
    genre: "都市",
    desc: "小人物、小裂缝、小团圆，情绪走轻暖路线。",
    beats: [
      { beat: "平凡日常", guide: "烟火气开场，建立人物与生活的质感" },
      { beat: "裂缝显现", guide: "一件小事戳中生活难处，情绪下沉" },
      { beat: "微光相助", guide: "陌生人/家人的小小善意，暖意回流" },
      { beat: "双向奔赴", guide: "人物主动迈出一步，关系破冰" },
      { beat: "烟火收尾", guide: "一顿饭/一盏灯收尾，余温留白" }
    ],
    style: { look: "柔光唯美", palette: "暖橘", ratio: "9:16" },
    brief_skeleton: "深夜的小餐馆里，两个陌生人因为一碗面聊了起来——",
    demo: { url: null, dur_sec: 50 }
  }
];

/* 惰性种子：state.templates 缺失才播种；已有则只补齐缺字段（不覆盖运营已改值） */
function ensureTemplates(st) {
  if (!st.templates || !Object.keys(st.templates).length) {
    st.templates = {};
    SEED_TEMPLATES.forEach((t) => { st.templates[t.id] = Object.assign({ enabled: true, ver: 1 }, t); });
    return true;
  }
  return false;
}

function normalizeBeat(b) {
  if (typeof b === "string") {
    const parts = b.split("|");
    return { beat: String(parts[0] || "").trim().slice(0, 20), guide: String(parts[1] || "").trim().slice(0, 120) };
  }
  if (b && typeof b === "object") {
    return { beat: String(b.beat || "").trim().slice(0, 20), guide: String(b.guide || "").trim().slice(0, 120) };
  }
  return null;
}

/* upsert 入参钳制：字段集固定，超长截断，版本只增 */
function normalizeTemplate(b, prev) {
  if (!b || !String(b.name || "").trim()) throw { code: "BAD_REQUEST", message: "模板名称必填" };
  const beats = (Array.isArray(b.beats) ? b.beats : []).map(normalizeBeat).filter(Boolean).slice(0, 8);
  const style = prev && prev.style ? Object.assign({}, prev.style) : { look: "写实电影感", palette: "青橙", ratio: "9:16" };
  const bs = b.style && typeof b.style === "object" ? b.style : {};
  ["look", "palette", "ratio"].forEach((k) => {
    if (bs[k] != null && String(bs[k]).trim()) style[k] = String(bs[k]).trim().slice(0, 20);
  });
  const demo = prev && prev.demo ? Object.assign({}, prev.demo) : { url: null, dur_sec: 45 };
  const bd = b.demo && typeof b.demo === "object" ? b.demo : {};
  if (bd.url != null) demo.url = String(bd.url || "").trim().slice(0, 300) || null;
  if (bd.dur_sec != null && Number(bd.dur_sec) > 0) demo.dur_sec = Math.round(Number(bd.dur_sec));
  return {
    id: (prev && prev.id) || null,
    name: String(b.name).trim().slice(0, 30),
    genre: String(b.genre || "").trim().slice(0, 10) || "通用",
    desc: String(b.desc || "").trim().slice(0, 120),
    beats,
    style,
    brief_skeleton: String(b.brief_skeleton || "").trim().slice(0, 120),
    demo,
    enabled: b.enabled == null ? (prev ? !!prev.enabled : true) : !!b.enabled,
    ver: (prev && prev.ver || 0) + 1,
    updated_at: Date.now()
  };
}

function register(router, ctx) {
  const { store, util, bus } = ctx;

  function requireOps(auth) {
    if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
    if ((auth.role || auth.role_name) !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
  }
  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // 种子：启动时补齐并落盘一次（幂等）
  if (ensureTemplates(store.get())) store.commit();

  // 创作者面文案消毒（对齐 api/state.js 的兜底纪律：fail-open，不阻断）
  function sanitizeCopy(text) {
    const lint = ctx.rules && ctx.rules.langlint;
    if (typeof text !== "string" || !lint || typeof lint.sanitize !== "function") return text;
    try {
      const s = lint.sanitize(text);
      return typeof s === "string" ? s : (s && typeof s.text === "string" ? s.text : text);
    } catch (e) { return text; }
  }
  function sanitizeTemplate(t) {
    const out = Object.assign({}, t);
    ["name", "genre", "desc", "brief_skeleton"].forEach((k) => { out[k] = sanitizeCopy(out[k]); });
    out.beats = (out.beats || []).map((b) => ({ beat: sanitizeCopy(b.beat), guide: sanitizeCopy(b.guide) }));
    return out;
  }

  // GET /api/templates — 创作者面：enabled 优先；ops 附带停用项（enabled:false 也可见）
  router.add(
    "GET",
    "/api/templates",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
      const st = store.get();
      const isOps = (auth.role || auth.role_name) === "ops";
      const list = Object.keys(st.templates || {})
        .map((k) => sanitizeTemplate(st.templates[k]))
        .filter((t) => isOps || t.enabled)
        .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0));
      return router.json(res, 200, { templates: list });
    },
    { auth: true }
  );

  // POST /api/admin/templates — upsert（带 id 改，不带新建）；ver 只增（NFR-08 版本化可回滚）
  router.add(
    "POST",
    "/api/admin/templates",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      st.templates = st.templates || {};
      const b = body || {};
      const prev = b.id ? st.templates[b.id] : null;
      if (b.id && !prev) throw { code: "NOT_FOUND", message: "模板不存在: " + b.id };
      const t = normalizeTemplate(b, prev);
      t.id = prev ? prev.id : util.uid("tpl");
      st.templates[t.id] = t;
      store.commit();
      audit(auth, prev ? "template_update" : "template_create", t.id, { name: t.name, ver: t.ver });
      try { bus.publish("alerts", { msg: "模板已更新：" + t.name + "（v" + t.ver + "）" }); } catch (e) {}
      return router.json(res, prev ? 200 : 201, { template: t });
    },
    { auth: true, role: "ops" }
  );

  // POST /api/admin/templates/remove {id, confirmed} — 删除需二次确认（缺 confirmed → 428 CONFIRM_REQ）
  router.add(
    "POST",
    "/api/admin/templates/remove",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const b = body || {};
      const t = (st.templates || {})[b.id];
      if (!t) throw { code: "NOT_FOUND", message: "模板不存在: " + b.id };
      if (!b.confirmed) {
        throw { code: "CONFIRM_REQ", message: "删除模板「" + t.name + "」不可撤销——请二次确认" };
      }
      delete st.templates[b.id];
      store.commit();
      audit(auth, "template_remove", b.id, { name: t.name });
      return router.json(res, 200, { removed: b.id });
    },
    { auth: true, role: "ops" }
  );
}

module.exports.register = register;
