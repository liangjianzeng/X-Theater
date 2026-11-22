"use strict";
/**
 * l2/advisor.js — 顾问卡构建器（2026-11-22）
 * 用户诉求：助手不是统计工具，是理解剧集任务、评估问题、推荐最优解的大脑——
 * 消息里直接给「可点的选项（选了就按既有通路执行）／提问（答复后继续）／跳转（直达项目剧集页）」。
 *
 * 纪律（红线不动）：
 *  - 选项只做两种事：send＝替用户把一句话发进会话（走完整 interpret→gate→审批治理链），
 *    href/tab＝纯客户端导航（路由跳转／助手栏切 tab）。没有任何「点了直接执行工具」的旁路。
 *  - 拍板类动作永远导向「确认票＋审批面板」或卡流页，绝不代拍板；停 LLM 一律导航运维台。
 *  - fail-silent：任何构建异常 → null（卡片是锦上添花，绝不阻断回执）。
 */

const HREF_RE = /^#\/[A-Za-z0-9_\-%=.\/]+$/; // 只许站内 hash 路由
const TABS = ["chat", "tasks", "apv"];

function epTitle(st, epId) {
  const ep = (st.episodes || {})[epId];
  return (ep && ep.title) || "";
}
function flowHref(epId) {
  return "#/ep/" + encodeURIComponent(String(epId || "")) + "/flow";
}
function costsHref(epId) {
  return "#/ep/" + encodeURIComponent(String(epId || "")) + "/costs";
}
function pendCards(st, epId, gov) {
  return Object.keys(st.cards || {}).map(k => st.cards[k])
    .filter(c => c.status === "pending" && String(c.episodeId) === String(epId))
    .sort((a, b) => gov.CARD_ORDER.indexOf(a.type) - gov.CARD_ORDER.indexOf(b.type));
}

/** 工具回执 → 推荐卡（无合适卡 → null） */
function buildCard(tool, args, r, ctx, session) {
  try {
    const gov = require("./governance.js");
    const st = ctx.store.get();
    const res = (r && r.result) || {};
    const epId = (args && args.episode_id) || res.episode_id || gov.defaultEpisodeId(ctx, session);

    /* 失败面：GPU_BUSY → 运维台（让路/切节点都是用户在运维台的决策） */
    if (r && !r.ok && r.code === "GPU_BUSY") {
      return { kind: "choices", options: [{ label: "去运维台处理", hint: "停 LLM 让路／切渲染节点", href: "#/admin" }] };
    }
    if (!r || !r.ok) return null;

    switch (tool) {
      case "query_cards": {
        const pend = pendCards(st, epId, gov);
        if (pend.length) {
          const first = pend[0];
          const name = gov.cardLabel(first.type);
          const digest = gov.cardDigest(first);
          return {
            kind: "choices",
            options: [
              { label: "去卡流页核对拍板", hint: name + (digest ? "·" + digest : ""), href: flowHref(epId) },
              { label: "让助手出修改建议", send: "给这张" + name + "卡出修改建议" },
              { label: "重出一版", send: "重出一版" + name }
            ]
          };
        }
        return {
          kind: "choices",
          options: [
            { label: "去工作台推进", href: flowHref(epId) },
            { label: "导出成片", hint: "先出交付预检", send: "导出成片" }
          ]
        };
      }
      case "query_gpu": {
        /* 本机 LLM 占卡才需要导航；DGX 驱动两不打架，不用提示 */
        if (res.episode_driver === "local" && res.llmOnline) {
          return { kind: "choices", options: [{ label: "去运维台处理", hint: "停 LLM 让路／切 DGX 节点", href: "#/admin" }] };
        }
        return null;
      }
      case "query_progress": {
        const done = Number(res.done) || 0, total = Number(res.total) || 0, queued = Number(res.queued) || 0;
        if (total > 0 && done >= total) {
          return {
            kind: "choices",
            options: [
              { label: "导出成片", hint: "预检全绿即可合成", send: "导出成片" },
              { label: "去复审台看看", href: "#/review" }
            ]
          };
        }
        if (queued > 0 && pendCards(st, epId, gov).length) {
          return { kind: "choices", options: [{ label: "看看待拍板的卡", send: "看看待拍板的卡" }, { label: "去卡流页", href: flowHref(epId) }] };
        }
        return null;
      }
      case "query_cost":
        return { kind: "choices", options: [{ label: "去成本页看逐镜账", href: costsHref(epId) }] };
      case "query_projects": {
        const n = (res.projects || []).length;
        if (!n) return { kind: "ask", question: "新剧叫什么名字？直接回复就行，比如「就叫灯塔来信」。" };
        return null;
      }
      case "create_project":
        return { kind: "ask", question: "要开第一集吗？回复一句话梗概（谁、在哪、干什么）我就建集派剧本。" };
      case "create_episode": {
        const nid = (args && args.episode_id) || res.episode_id || null;
        return nid ? { kind: "choices", options: [{ label: "去卡流页跟进", href: flowHref(nid) }] } : null;
      }
      case "suggest_card":
        return {
          kind: "choices",
          options: [
            { label: "去卡流页看建议详情", href: flowHref(epId) },
            { label: "按建议改剧本", hint: "会出确认票", send: "按建议修订剧本" }
          ]
        };
      default:
        return null;
    }
  } catch (e) {
    return null; // fail-silent
  }
}

/** 昂贵动作出票后 → 引导去审批面板（不代批） */
function approvalCard() {
  return { kind: "choices", options: [{ label: "去审批面板批准", tab: "apv" }, { label: "先不批", send: "先不批" }] };
}

/** 解析不出意图时 → 能力菜单卡（LLM 离线兜底的可见出口） */
function menuCard(ctx, session) {
  try {
    const gov = require("./governance.js");
    const st = ctx.store.get();
    const epId = gov.defaultEpisodeId(ctx, session);
    const opts = [];
    if (epId && pendCards(st, epId, gov).length) opts.push({ label: "看看待拍板的卡", send: "看看待拍板的卡" });
    if (epId) opts.push({ label: "本集现在到哪一步了", send: "本集现在到哪一步了" });
    opts.push({ label: "成本花了多少", send: "成本花了多少" });
    return { kind: "choices", options: opts.slice(0, 3) };
  } catch (e) {
    return null;
  }
}

module.exports = { buildCard, approvalCard, menuCard, HREF_RE, TABS };
