"use strict";
/**
 * L2 模式 A —— dsh-stub（模拟 DSH 沙箱实例，ADR-003 §4 控制面/§5.2 化解表，契约 §5）
 *
 * 一期默认承载：每会话一个容器化 DSH 实例。本 stub 模拟实例面语义（真实例接入时替换本执行器即可，
 * AgentRuntimeAdapter 契约不变）：
 *  - 独立 inst_id 空间（实例 id 与剧场会话 id 双轨）；
 *  - 配置＝剧场下发：{pin:"v1.2.3"（版本 pin 死）, home:"~/.dsh-tenant"（每会话一个数据家）,
 *    net_allowlist:["theater-mcp","llm-gw"]（出网白名单）, turn_limit}；
 *  - DSH 自带 shell/文件/代码执行类工具整体禁用（红线）：剧场下发工具配置里出现白名单外工具 →
 *    **spawn 期即拒**（{code:"FORBIDDEN"}＋agentrun 账本 denied），不是运行期才拦；
 *  - ApprovalPanel 仅展示层：确认票/预算/审计全在剧场 governance（DSH 侧任何「同意」都只是信号）。
 *
 * dsh-stub 对「实例内部如何决策」用剧场侧确定性 mock（复用模式 B 的规则式意图表模拟 instance tool_use），
 * 真实 DSH 上线后该段由实例 tool_use 事件流替代，事件流形态不变。
 */
const adapter = require("./adapter.js");
const governance = require("./governance.js");
const modeB = require("./modeB.js"); // 复用同一张确定性意图表模拟实例 tool_use 决策（stub 语义）

const DSH_PIN = "v1.2.3";
const DSH_HOME = "~/.dsh-tenant";
const NET_ALLOWLIST = ["theater-mcp", "llm-gw"];

function createModeARuntime(session, ctx) {
  let terminated = false;
  const util = ctx.util;

  function spawn() {
    if (terminated) return { ok: false, code: "BROKEN", message: "实例已销毁" };
    // 剧场下发的实例工具配置（准入硬验收③：工具列表快照＋越权调用被拒）
    const injected =
      ctx.cfg && Array.isArray(ctx.cfg.dsh_injected_tools) && ctx.cfg.dsh_injected_tools.length
        ? ctx.cfg.dsh_injected_tools
        : governance.WHITELIST.slice();
    const bad = injected.filter(function (t) {
      return governance.WHITELIST.indexOf(t) < 0;
    });
    if (bad.length) {
      // 红线：白名单外工具（shell/文件/代码执行面）spawn 期即拒——不进实例，不留到运行期
      governance.ledger(ctx, session, {
        tool: String(bad[0]),
        status: "denied",
        code: "FORBIDDEN",
        args: { stage: "spawn", injected: injected, rejected: bad },
        trace_id: governance.newTrace(ctx, session, "spawn_denied")
      });
      ctx.store.commit();
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "DSH 实例配置含白名单外工具（spawn 期即拒）：" + bad.join(",")
      };
    }
    session.runtime = {
      kind: "dsh-stub",
      inst_id: "dsh-" + String(util.hash12({ sid: session.id, uid: session.uid })), // 独立实例 id 空间
      pin: (ctx.cfg && ctx.cfg.dsh_pin) || DSH_PIN, // 实例版本 pin 死，升级走每周契约回归
      home: DSH_HOME, // 每会话一个数据家（销毁即弃）
      net_allowlist: NET_ALLOWLIST.slice(), // 出网＝theater-mcp 网关＋LLM 通道
      whitelist: injected.slice(), // 工具面只许 theater-mcp 白名单
      turn_limit: (ctx.cfg && ctx.cfg.dsh_turn_limit) || 20,
      turns: session.runtime ? session.runtime.turns || 0 : 0
    };
    governance.ledger(ctx, session, {
      tool: "runtime_spawn",
      status: "ok",
      args: {
        mode: "A",
        inst_id: session.runtime.inst_id,
        pin: session.runtime.pin,
        home: session.runtime.home,
        net_allowlist: session.runtime.net_allowlist
      },
      trace_id: governance.newTrace(ctx, session, "spawn")
    });
    ctx.store.commit();
    return { ok: true, inst_id: session.runtime.inst_id, runtime: session.runtime };
  }

  return {
    kind: "dsh-stub",
    spawn: spawn,
    streamInput: async function (input, auth) {
      if (terminated) return { ok: false, code: "BROKEN", message: "实例已销毁" };
      if (!session.runtime || session.runtime.kind !== "dsh-stub") {
        const sp = spawn();
        if (!sp.ok) return { ok: false, code: sp.code, message: sp.message };
      }
      if (session.runtime && typeof session.runtime.turns === "number") {
        session.runtime.turns += 1;
        if (session.runtime.turns > session.runtime.turn_limit) {
          // 准入硬验收⑥：实例侧 turn 上限＋服务端现金熔断双保险
          return { ok: false, code: "TURN_LIMIT", message: "实例超过单会话 turn 上限（护栏三层上限）" };
        }
      }
      return adapter.runTurn({
        mode: "A",
        session: session,
        ctx: ctx,
        input: input,
        auth: auth,
        interpret: { detect: modeB.detectInjection, parse: modeB.parseIntent }
      });
    },
    terminate: function () {
      // 先导出后销毁（AgentRuntimeAdapter 语义）：trace 已实时汇聚 agentrun 账本（collector 语义），销毁无数据损失
      terminated = true;
      governance.ledger(ctx, session, {
        tool: "runtime_terminate",
        status: "ok",
        args: { mode: "A", inst_id: session.runtime && session.runtime.inst_id },
        trace_id: governance.newTrace(ctx, session, "terminate")
      });
      ctx.store.commit();
    },
    traceTail: function () {
      return governance.traceTail(ctx, session);
    }
  };
}

module.exports = { createModeARuntime, DSH_PIN, DSH_HOME, NET_ALLOWLIST };
