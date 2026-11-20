"use strict";
/**
 * api/state.js — 总览（契约 §3：GET /api/state）
 * projects/episodes/shots(按集)/cards pending 摘要/队列态。
 * 用户面禁词过滤兜底：对展示文案跑 ctx.rules.langlint.sanitize，
 * 命中 → 就地替换为语言表层文案并记告警（alerts + bus + audit）。
 */

const DISPLAY_FIELDS = {
  episodes: ["title", "brief"],
  scenes: ["name"],
  shots: ["name"],
  review_q: ["reason"],
  alerts: ["msg"]
};

function normalizeHits(hits) {
  return (hits || []).map((h) => (typeof h === "string" ? h : (h && (h.term || h.word)) || String(h)));
}

function sanitizeText(ctx, text) {
  // 返回 {text, hits:[..]}；兼容 rules.langlint 的两种形态：
  //   sanitize(text)→string（hits 用 lint 预算）或 sanitize(text)→{text,hits}。
  // rules 缺失时原样放行。
  const lint = ctx.rules && ctx.rules.langlint;
  if (typeof text !== "string" || !lint) return { text, hits: [] };
  let hits = [];
  try {
    if (typeof lint.lint === "function") {
      const r = lint.lint(text, { exempt: false });
      hits = normalizeHits(r && r.hits);
    }
  } catch (e) {
    /* lint 失败不阻断 */
  }
  let out = text;
  try {
    if (typeof lint.sanitize === "function") {
      const s = lint.sanitize(text);
      if (typeof s === "string") {
        out = s;
      } else if (s && typeof s === "object") {
        if (typeof s.text === "string") out = s.text;
        if (!hits.length) hits = normalizeHits(s.hits);
      }
    } else if (typeof lint.lint === "function" && hits.length) {
      hits.forEach((w) => {
        if (w) out = out.split(w).join("语言表层文案");
      });
    }
  } catch (e) {
    /* 兜底过滤失败不阻断总览 */
  }
  if (!hits.length && out !== text) hits = ["(replaced)"];
  return { text: out, hits };
}

function sanitizeBag(ctx, bag, fields, hits) {
  if (!bag) return;
  fields.forEach((f) => {
    if (typeof bag[f] === "string") {
      const r = sanitizeText(ctx, bag[f]);
      if (r.hits && r.hits.length) {
        hits.push.apply(hits, r.hits.map(String));
        bag[f] = r.text;
      }
    }
  });
}

function sanitizeDeepStrings(ctx, value, hits, depth) {
  // 卡片 payload：全字符串叶子过滤。
  depth = depth || 0;
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    const r = sanitizeText(ctx, value);
    if (r.hits && r.hits.length) {
      hits.push.apply(hits, r.hits.map(String));
      return r.text;
    }
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      value[i] = sanitizeDeepStrings(ctx, v, hits, depth + 1);
    });
    return value;
  }
  if (typeof value === "object") {
    Object.keys(value).forEach((k) => {
      if (k === "id" || k === "art" || k === "engine" || k === "trace_id") return; // 标识/引擎名不动
      value[k] = sanitizeDeepStrings(ctx, value[k], hits, depth + 1);
    });
  }
  return value;
}

function queueSummary(ctx) {
  try {
    const q = ctx.engine.queueState();
    if (Array.isArray(q)) return q;
    if (q && Array.isArray(q.jobs)) return q.jobs;
    return q || null;
  } catch (e) {
    return ctx.store.readLog("job");
  }
}

function register(router, ctx) {
  const { store, bus, util } = ctx;

  router.add(
    "GET",
    "/api/state",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const hits = [];

      const episodes = Object.keys(st.episodes || {})
        .sort()
        .map((k) => {
          const ep = st.episodes[k];
          sanitizeBag(ctx, ep, DISPLAY_FIELDS.episodes, hits); // 就地替换＋持久
          return Object.assign({}, ep);
        });

      const shotsByEpisode = {};
      Object.keys(st.shots || {})
        .sort()
        .forEach((k) => {
          const sh = st.shots[k];
          sanitizeBag(ctx, sh, DISPLAY_FIELDS.shots, hits);
          (shotsByEpisode[sh.episodeId] = shotsByEpisode[sh.episodeId] || []).push(Object.assign({}, sh));
        });
      Object.keys(shotsByEpisode).forEach((eid) =>
        shotsByEpisode[eid].sort((a, b) => (a.seq || 0) - (b.seq || 0))
      );

      const scenesByEpisode = {};
      Object.keys(st.scenes || {}).forEach((k) => {
        const sc = st.scenes[k];
        const clone = Object.assign({}, sc);
        sanitizeBag(ctx, clone, DISPLAY_FIELDS.scenes, hits);
        (scenesByEpisode[sc.episodeId] = scenesByEpisode[sc.episodeId] || []).push(clone);
      });
      Object.keys(scenesByEpisode).forEach((eid) =>
        scenesByEpisode[eid].sort((a, b) => (a.seq || 0) - (b.seq || 0))
      );

      const cardsPending = Object.keys(st.cards || {})
        .sort((a, b) => {
          const ca = st.cards[a], cb = st.cards[b];
          return (ca.created_at || 0) - (cb.created_at || 0) || String(a).localeCompare(String(b));
        })
        .map((k) => st.cards[k])
        .filter((c) => c.status === "pending")
        .filter((c) => {
          // music_enabled=false 的项目不出 C9
          if (c.type !== "C9") return true;
          const ep = (st.episodes || {})[c.episodeId];
          const pj = ep && (st.projects || {})[ep.projectId];
          return !(pj && pj.music_enabled === false);
        })
        .map((c) => {
          // 兜底＝就地替换（避免每次 GET 重复告警），payload 为普通 JSON 结构
          const payload = sanitizeDeepStrings(ctx, c.payload || {}, hits);
          c.payload = payload;
          return {
            id: c.id,
            episodeId: c.episodeId,
            type: c.type,
            status: c.status,
            ver: c.ver,
            decided_by: c.decided_by || null,
            decided_at: c.decided_at || null,
            payload
          };
        });

      const reviewPending = (st.review_q || [])
        .filter((r) => r.status === "pending")
        .map((r) => {
          const clone = Object.assign({}, r);
          sanitizeBag(ctx, clone, DISPLAY_FIELDS.review_q, hits);
          return clone;
        });

      if (hits.length) {
        const uniq = Array.from(new Set(hits));
        const alert = {
          id: util.uid("al"),
          kind: "langlint",
          msg: "用户面文案已过滤禁词并替换为语言表层文案：" + uniq.slice(0, 8).join("、"),
          ts: util.now(),
          acked: false
        };
        st.alerts = st.alerts || [];
        st.alerts.push(alert);
        store.commit();
        store.log("audit", {
          operator: (auth && (auth.uid || auth.id)) || null,
          action: "langlint_sanitize",
          target: "state",
          hits: uniq.slice(0, 20)
        });
        try { bus.publish("alerts", alert); } catch (e) { /* SSE 未就绪 */ }
      }

      return router.json(res, 200, {
        server_time: util.now(),
        projects: st.projects || {},
        episodes,
        scenes_by_episode: scenesByEpisode,
        shots_by_episode: shotsByEpisode,
        cards_pending: cardsPending,
        review_pending: reviewPending,
        music_library: (st.music_lib || []).length,
        alerts_unacked: (st.alerts || []).filter((a) => !a.acked).length,
        queue: queueSummary(ctx)
      });
    },
    { auth: true }
  );
}

module.exports.register = register;
