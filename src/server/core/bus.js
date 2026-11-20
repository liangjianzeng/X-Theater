"use strict";
/**
 * core/bus.js — SSE 事件总线（契约 §2）
 * bus.publish(topic,obj)   topic: "jobs"|"cards"|"alerts"|"l2:<sid>"|"review"
 * bus.attach(res,opts)     res 转 SSE（含 :ping 15s 心跳）；opts.session 决定 l2:<sid> 是否订阅
 * bus.detach(res)
 * 线格式：`data: ${JSON.stringify({topic,...obj})}\n\n`
 */

function createBus() {
  const clients = new Set(); // {res, filter(topic)->bool}
  const listeners = new Map(); // topic → Set<fn>（服务端进程内订阅，api 卡流/L2 依赖）

  function on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => off(topic, fn);
  }

  function off(topic, fn) {
    const s = listeners.get(topic);
    if (s) s.delete(fn);
  }

  function publish(topic, obj) {
    // 进程内订阅先走（同步、逐个容错，不打挂总线）
    const s = listeners.get(topic);
    if (s) {
      for (const fn of s) {
        try { fn(Object.assign({ topic }, obj || {})); } catch (e) { /* 订阅者异常隔离 */ }
      }
    }
    const line = "data: " + JSON.stringify(Object.assign({ topic }, obj || {})) + "\n\n";
    for (const c of clients) {
      try {
        if (c.filter && !c.filter(topic)) continue;
        if (!c.res.writableEnded) c.res.write(line);
      } catch (e) {
        /* 写失败的连接由 close 事件摘除 */
      }
    }
  }

  /**
   * attach(res, opts)
   * opts:{ session?:string, filter?:(topic)=>bool }
   * 默认：收全部非 l2 topic；带 opts.session 时另订 "l2:<session>"（契约 §3 GET /events 语义）。
   */
  function attach(res, opts) {
    const o = opts || {};
    let filter;
    if (typeof o.filter === "function") filter = o.filter;
    else if (o.session) {
      const want = "l2:" + o.session;
      filter = (t) => !(typeof t === "string" && t.indexOf("l2:") === 0) || t === want;
    } else {
      filter = (t) => !(typeof t === "string" && t.indexOf("l2:") === 0);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(":connected\n\n");

    const client = { res, filter };
    clients.add(client);
    const ping = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(":ping\n\n");
      } catch (e) {
        /* close 事件负责摘除 */
      }
    }, 15000);
    if (ping.unref) ping.unref();

    res.on("close", () => {
      clearInterval(ping);
      clients.delete(client);
    });
    return () => detach(res);
  }

  function detach(res) {
    for (const c of clients) {
      if (c.res === res) clients.delete(c);
    }
  }

  return { publish, on, off, attach, detach };
}

module.exports = { createBus };
