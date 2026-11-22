"use strict";
/**
 * L2 模式 B —— selfloop（自研轻量 loop，ADR-003 D7 兜底位，契约 §5）
 *
 * 规则式意图解析：正则表覆盖 5 类任务（进度/成本/重拍第N镜/择优/查询项目）＋音乐（配乐 mood 设定/出配乐候选/导出）。
 * 解析→工具序列同白名单工具面；裁决全走 governance（与模式 A 共享治理面）。
 */
const adapter = require("./adapter.js");
const governance = require("./governance.js");

const MOODS = ["释然", "离别", "压抑", "温馨", "紧张", "悬疑", "欢快", "悲伤", "伤感", "治愈", "平静", "热烈"];

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };
function toNum(tok) {
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  if (CN_NUM[tok] != null) return CN_NUM[tok];
  if (tok.length === 2 && tok[0] === "十") return 10 + (CN_NUM[tok[1]] || 0);
  if (tok.length === 2 && tok[1] === "十") return (CN_NUM[tok[0]] || 0) * 10;
  return null;
}

// —— 注入样式检测（红队①）：命中＝不解析任何工具，人话拒答 + 账本 injection_suspect ——
const INJECTION_PATTERNS = [
  [/忽略[^\s。！]{0,6}(指令|规则|设定|安全|约束)/, "ignore_instructions"],
  [/无视[^\s。！]{0,6}(指令|规则|安全|约束)/, "ignore_instructions"],
  [/绕过[^\s。！]{0,6}(审批|确认|护栏|预算|门)/, "bypass_gate"],
  [/越权/, "escalation"],
  [/\brm\s+-rf\b/i, "rm_rf"],
  [/\bshell\b/i, "shell"],
  [/调用\s*(?:shell|bash|sh\b|脚本|代码执行|外部命令)/i, "shell_call"],
  [/\bexport_all\b/i, "export_all"],
  [/\bsystem\s*prompt\b/i, "system_prompt"],
  [/(?:执行|运行)\s*(?:代码|命令|脚本|python|node)/i, "exec_code"],
  [/(?:把|将)[^\s。！]{0,8}(?:全部|所有)[^\s。！]{0,8}(?:导出|删光|删除|打包)/, "bulk_exfil"]
];
const FAKE_TOOL_RE = /\b(export_all|shell|bash|eval|exec|rm|sudo)\b/i;

function detectInjection(text) {
  const t = String(text || "");
  for (const pair of INJECTION_PATTERNS) {
    if (pair[0].test(t)) {
      const fake = t.match(FAKE_TOOL_RE);
      return { pattern: pair[1], tool: fake ? fake[1].toLowerCase() : null };
    }
  }
  return null;
}

function extractShotNo(text) {
  const m = String(text).match(/第\s*([0-9一二三四五六七八九十两]+)\s*(?:镜|个镜头|镜头|条)/);
  return m ? toNum(m[1]) : null;
}
function extractSceneNo(text) {
  const m = String(text).match(/场\s*([0-9一二三四五六七八九十两]+)/);
  return m ? toNum(m[1]) : null;
}
function extractMood(text) {
  for (const mood of MOODS) {
    if (String(text).indexOf(mood) >= 0) return mood;
  }
  return null;
}
function extractEpisodeId(text) {
  const m =
    String(text).match(/(?:episode|ep|集)\s*[:：=]?\s*(e[\w-]+)/i) ||
    String(text).match(/(?:查询|查一下|查|看看|询)\s*(e[\w-]+)/i);
  return m ? m[1] : null;
}

/** chips（@上下文芯片）并入参数面；异 session/uid 芯片交给 governance 判 FORBIDDEN（红队③） */
function mergeChips(args, chips) {
  (chips || []).forEach(function (c) {
    if (!c || !c.id) return;
    const t = String(c.type || "").toLowerCase();
    if (t === "episode") args.episode_id = c.id;
    else if (t === "shot") args.shot_id = c.id;
    else if (t === "scene") args.scene_id = c.id;
    else if (t === "session") args.session_id = c.id;
    else if (t === "user" || t === "uid" || t === "owner") args.uid = c.id;
  });
  return args;
}

function shotsOfEpisode(ctx, epId) {
  const st = ctx.store.get();
  return Object.values(st.shots || {})
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
}
function sceneAt(ctx, epId, n) {
  const st = ctx.store.get();
  const list = Object.values(st.scenes || {})
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  return list[n - 1] || null;
}

/**
 * 规则式意图解析（正则表；顺序＝优先特异性）。返回 {tool,args} | {refusal,name} | null。
 */
function parseIntent(text, chips, ctx, session) {
  const t = String(text || "");
  const epId = extractEpisodeId(t) || governance.defaultEpisodeId(ctx, session);
  const base = {};
  mergeChips(base, chips);
  if (epId && base.episode_id == null) base.episode_id = epId;
  // 所有分支都并入 base：芯片里的 session/uid 等必须进入 args 交给 governance 做租户裁决（红队③）
  const mkArgs = function (extra) {
    return Object.assign({}, base, extra);
  };

  const shotNo = extractShotNo(t);
  const sceneNo = extractSceneNo(t);
  const mood = extractMood(t);

  const wantMoodSet = /(mood|情绪|基调)[^。！？]{0,6}(设|改|定)|(设|改|定)[^。！？]{0,6}(mood|情绪|基调)/i.test(t);
  const wantMusic = /配乐|bgm|来\s*[0-9一二三四五两]+\s*(?:段|首|条)|候选|生成.{0,4}(音乐|配乐)|出.{0,4}(音乐|配乐)/i.test(t);
  const wantReroll = /重拍|重绘|再拍|再来一?[条个]/.test(t);
  const wantPick = /择优|选(?:最|择)|最佳|挑一?条/.test(t);
  const wantCost = /成本|花了|花费|费用|预算|多少钱/.test(t);
  const wantProject = /项目/.test(t) && /(哪些|列表|列|几个|多少|查询|查)/.test(t);
  const wantProgress = /进度|完成|怎么样|咋样|状态|拍得|进行|到哪一步|走到哪|进展/.test(t);
  // 卡流/GPU 查询（2026-11-22 芯片联动）：只读；拍板动作（批准/驳回/重出一版）不进规则表——拍板权在人
  const wantCards = /待拍板|拍板|卡流|哪张卡|几张卡|卡片/.test(t);
  const wantGpu = /被挡|挡了|开不了机|显存|GPU|gpu|显卡/.test(t);
  const wantNewShow = /新建|建一部|开一部|新剧|创建/.test(t);
  const wantExport = /导出|成片|出片/.test(t);

  // —— 音乐类（先于 mood：出候选句里也可能带情绪词）——
  if (wantMusic && !wantMoodSet) {
    const scene = sceneNo ? sceneAt(ctx, epId, sceneNo) : null;
    if (!scene && base.scene_id == null) {
      return { refusal: "出配乐候选得指明是哪一场，比如「给场1出配乐候选」。", name: "music_candidates" };
    }
    const sceneId = base.scene_id || scene.id;
    const st = ctx.store.get();
    const sc = st.scenes[sceneId];
    return {
      tool: "music_candidates",
      name: "music_candidates",
      args: mkArgs({ episode_id: epId, scene_id: sceneId, mood: mood || (sc && sc.mood) || "释然" })
    };
  }
  // —— 配乐 mood 设定 ——
  if (wantMoodSet && mood) {
    const scene = sceneNo ? sceneAt(ctx, epId, sceneNo) : null;
    const sceneId = base.scene_id || (scene ? scene.id : null);
    if (!sceneId) return { refusal: "设情绪也得说是哪一场，比如「把场1的情绪改为压抑」。", name: "set_mood" };
    return { tool: "set_mood", name: "set_mood", args: mkArgs({ episode_id: epId, scene_id: sceneId, mood: mood }) };
  }
  // —— 重拍第N镜（昂贵）——
  if (wantReroll) {
    let shotId = base.shot_id || null;
    if (!shotId && shotNo) {
      const list = shotsOfEpisode(ctx, epId);
      const sh = list[shotNo - 1];
      shotId = sh ? sh.id : null;
    }
    if (!shotId) return { refusal: adapter.REPLY.need_shot_no, name: "reroll_shot" };
    return { tool: "reroll_shot", name: "reroll_shot", args: mkArgs({ episode_id: epId, shot_id: shotId }) };
  }
  // —— 择优（第N镜）——
  if (wantPick) {
    let shotId = base.shot_id || null;
    if (!shotId && shotNo) {
      const list = shotsOfEpisode(ctx, epId);
      const sh = list[shotNo - 1];
      shotId = sh ? sh.id : null;
    }
    if (!shotId) return { refusal: adapter.REPLY.need_shot_no, name: "pick_take" };
    return { tool: "pick_take", name: "pick_take", args: mkArgs({ episode_id: epId, shot_id: shotId }) };
  }
  // —— 成本 ——
  if (wantCost) {
    return { tool: "query_cost", name: "query_cost", args: mkArgs({ episode_id: epId }) };
  }
  // —— 查询项目（5 类之一；单租户种子＝列出项目+进度）——
  if (wantProject) {
    return { tool: "query_progress", name: "query_projects", args: mkArgs({}) };
  }
  // —— 卡流查询（只读；LLM 在线时同样落 query_cards，两张脸一个语义）——
  if (wantCards) {
    return { tool: "query_cards", name: "query_cards", args: mkArgs({ episode_id: epId }) };
  }
  // —— GPU/节点闸解释（只读；「停止 LLM 让路」在运维台，助手不代停）——
  if (wantGpu) {
    return { tool: "query_gpu", name: "query_gpu", args: mkArgs({ episode_id: epId }) };
  }
  // —— 新建剧（规则模式保守引导：没剧名不能盲建；LLM 在线时由 LLM 追问剧名一步到位）——
  if (wantNewShow) {
    return { refusal: "新建一部剧得先有剧名，比如「帮我新建一部剧，就叫灯塔来信」。", name: "create_project" };
  }
  // —— 进度 ——
  if (wantProgress || /查/.test(t)) {
    return { tool: "query_progress", name: "query_progress", args: mkArgs({ episode_id: epId }) };
  }
  // —— 导出（覆盖意图但白名单无此工具 → 人话拒答，不算注入）——
  if (wantExport) {
    return { refusal: adapter.REPLY.export, name: "export" };
  }
  return null;
}

/** 模式 B：自研 loop（ADR-003：几百行循环，本就非护城河；同契约同治理面） */
function createModeBRuntime(session, ctx) {
  let terminated = false;
  return {
    kind: "selfloop",
    spawn: function () {
      if (terminated) return { ok: false, code: "BROKEN", message: "runtime 已终止" };
      session.runtime = {
        kind: "selfloop",
        loop: "selfloop",
        whitelist: governance.WHITELIST.slice(),
        turn_limit: 20,
        turns: session.runtime ? session.runtime.turns || 0 : 0
      };
      governance.ledger(ctx, session, {
        tool: "runtime_spawn",
        status: "ok",
        args: { mode: "B", loop: "selfloop" },
        trace_id: governance.newTrace(ctx, session, "spawn")
      });
      ctx.store.commit();
      return { ok: true, inst_id: "selfloop-" + session.id };
    },
    streamInput: async function (input, auth) {
      if (terminated) return { ok: false, code: "BROKEN", message: "runtime 已终止" };
      if (session.runtime && typeof session.runtime.turns === "number") {
        session.runtime.turns += 1;
        if (session.runtime.turns > session.runtime.turn_limit) {
          return { ok: false, code: "TURN_LIMIT", message: "超过单会话 turn 上限（护栏三层上限）" };
        }
      }
      return adapter.runTurn({
        mode: "B",
        session: session,
        ctx: ctx,
        input: input,
        auth: auth,
        interpret: require("./llmintent.js").buildInterpret(ctx, { detect: detectInjection, parse: parseIntent })
      });
    },
    terminate: function () {
      terminated = true;
      governance.ledger(ctx, session, {
        tool: "runtime_terminate",
        status: "ok",
        args: { mode: "B" },
        trace_id: governance.newTrace(ctx, session, "terminate")
      });
      ctx.store.commit();
    },
    traceTail: function () {
      return governance.traceTail(ctx, session);
    }
  };
}

module.exports = {
  createModeBRuntime,
  parseIntent,
  detectInjection,
  mergeChips,
  extractShotNo,
  extractMood,
  sceneAt,
  shotsOfEpisode,
  MOODS
};
