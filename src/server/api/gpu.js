"use strict";
/**
 * api/gpu.js — GPU/LLM 状态面（2026-11-21，llm-gw 配套）
 * GET  /api/gpu → {llm:{online,model,configured}, comfy:{online,vram_total_mib,vram_free_mib}, gpu_busy}
 *                数据来自 llm-gw 3s 监视缓存（同步快照，不现场探测）。
 * POST /api/gpu/llm/stop → 一键让路：停本机 llama-server 释放独显（审计留痕；不自动重启——
 *                重启脚本路径随当前 LLM 节点档案（state.nodes[llm_node].llm.bat）在 restart_hint 返回）。
 */

const fs = require("fs");

function register(router, ctx) {
  const { store, util, cfg } = ctx;

  router.add(
    "GET",
    "/api/gpu",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const llm = ctx.llm && ctx.llm.enabled() ? ctx.llm.cached() : { configured: false, llmOnline: false };
      return router.json(res, 200, {
        ts: util.now(),
        llm: {
          configured: !!llm.configured,
          online: !!llm.llmOnline,
          model: llm.llmModel || null,
          age_s: llm.age_s != null ? llm.age_s : null
        },
        comfy: llm.comfy || { online: false },
        gpu_busy: !!(llm.configured && llm.llmOnline), // LLM 在线＝本机 Comfy 生图/拍摄被闸
        restart_hint: (cfg.llm && cfg.llm.bat) || "" // 拉起脚本跟随当前 LLM 节点档案，不硬编码
      });
    },
    { auth: true }
  );

  router.add(
    "POST",
    "/api/gpu/llm/stop",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      if (!ctx.llm || !ctx.llm.enabled()) {
        return router.json(res, 400, { error: { code: "BAD_REQUEST", message: "未配置 LLM 端点（THEATER_LLM_URL）" } });
      }
      return Promise.resolve(ctx.llm.stop()).then((r) => {
        store.log("audit", {
          operator: (auth && (auth.uid || auth.id)) || null,
          action: "llm_stop",
          target: "llm-gw",
          ok: !!r.ok,
          pid: r.pid || null,
          message: r.message || null
        });
        try {
          ctx.bus.publish("alerts", {
            id: util.uid("al"),
            kind: "llm_stop",
            msg: r.ok ? "LLM 已停止让路（显存释放，生图/拍摄恢复）" : "LLM 停止失败：" + (r.message || ""),
            ts: util.now(),
            acked: false
          });
        } catch (e) { /* SSE 未就绪 */ }
        return router.json(res, r.ok ? 200 : 500, r);
      });
    },
    { auth: true }
  );
}

module.exports.register = register;
