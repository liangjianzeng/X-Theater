/* 剧场 Studio · 复审台视图（视图 B：review） */
// BACKEND-ISSUE: GET /api/review/queue 的种子项（rv_1）缺 ts（送审时间）与 ver 字段
//   （cards.js 新入审的条目带 ts/ver）。缺 ts 时本视图送审时间渲染「—」；缺 ver 由服务端补 1。
//   期望：种子 review_q 与 /queue 响应统一补 ts、ver。
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const RQ_STATE = {
    pending: ["待复审", "badge-warn"],
    pass: ["已放行", "badge-ok"],
    reject: ["已打回", "badge-err"],
    offline: ["已下架", "badge"]
  };

  function hueOf(s) {
    let h = 0;
    const x = String(s || "");
    for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function slaText(sec) {
    if (sec == null || !Number.isFinite(Number(sec))) return "—";
    const s = Math.round(Number(sec));
    if (s <= 0) return "已超时";
    if (s < 60) return s + " 秒";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " 分钟";
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h + " 小时" + (m ? " " + m + " 分" : "");
  }

  views.Review = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "time-ago": T.components.TimeAgo,
      "loading": T.components.Loading
    },
    template: `
      <div class="v-review">
        <div class="panel">
          <div class="panel-title">复审队列
            <span class="badge badge-warn" v-if="pending">待处置 <b class="num">{{ pending }}</b></span>
            <button class="btn btn-ghost btn-sm" @click="showAll = !showAll">{{ showAll ? '只看待处置' : '显示已处置（' + ((queue || []).length - pending) + '）' }}</button>
            <button class="btn btn-ghost btn-sm" @click="reload" :aria-busy="loading">刷新</button>
          </div>
          <loading v-if="loading && !queue"></loading>
          <err-state v-else-if="err && !queue" :err="err" :on-retry="reload"></err-state>
          <empty-state v-else-if="queueView && !queueView.length" icon="🧐"
            text="没有待复审镜头" sub="机审拿不准、需要人工拍板的镜头会第一时间送进这里"></empty-state>
          <div class="list" v-else-if="queueView">
            <div class="list-item v-review-item" v-for="it in queueView" :key="it.id"
                 :class="{ 'v-review-stale': !!stale[it.id] }">
              <div class="v-review-thumb" :style="it.frame ? null : thumbStyle(it)">
                <img v-if="it.frame" :src="'/' + it.frame" style="width:100%;height:100%;object-fit:cover" alt="分镜首帧" />
              </div>
              <div class="grow col">
                <div class="row wrap">
                  <b>{{ shotLabel(it) }}</b>
                  <span class="badge" :class="stOf(it)[1]">{{ stOf(it)[0] }}</span>
                  <span class="weak">SLA 剩余 <b class="num" :style="sla(it)==='已超时' ? {color:'var(--err)'} : null">{{ sla(it) }}</b></span>
                  <span class="muted" v-if="it.ts">送审于 <time-ago :ts="it.ts"></time-ago></span>
                  <a v-if="it.takeArt" class="btn btn-sm" :href="'/' + it.takeArt" target="_blank">▶ 看这条片</a>
                  <button class="btn btn-sm btn-ghost" v-if="it.prompt" @click="showPrompt(it)">📋 受控要素</button>
                </div>
                <div class="card-sub">{{ hs(it.reason) }}</div>
                <div class="weak" v-if="it.sec">{{ it.sec }} 秒 · 分镜首帧见左侧</div>
                <err-state v-if="stale[it.id]" compact :err="stale[it.id]"
                  :on-retry="() => retryItem(it)"></err-state>
                <div class="row wrap" v-if="it.status === 'pending' && !stale[it.id]">
                  <button class="btn btn-primary btn-sm" :disabled="busy === it.id" :aria-busy="busy === it.id"
                    @click="decide(it, 'pass')">通过</button>
                  <button class="btn btn-sm" :disabled="busy === it.id || rejectId === it.id"
                    @click="openReject(it)">打回</button>
                  <button class="btn btn-danger btn-sm" :disabled="busy === it.id" :aria-busy="busy === it.id"
                    @click="decide(it, 'offline')">下架</button>
                </div>
                <div class="row wrap v-review-reject" v-if="rejectId === it.id && !stale[it.id]">
                  <input class="input grow" v-model.trim="rejectText" placeholder="写明打回理由：要重拍什么、改什么（必填）"
                    @keyup.enter="decide(it, 'reject')" />
                  <button class="btn btn-danger btn-sm" :disabled="busy === it.id || !rejectText"
                    @click="decide(it, 'reject')">确认打回</button>
                  <button class="btn btn-ghost btn-sm" @click="cancelReject">取消</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`,
    setup() {
      const busy = Vue.ref(null);
      const rejectId = Vue.ref(null);
      const rejectText = Vue.ref("");
      const stale = Vue.reactive({});
      /* 单一真相（2026-11-21）：默认只看待处置——历史 pass/offline 条目堆在同列表里
         曾导致「几条完全一样的东西鬼都不认得」；点「显示已处置」才展开历史 */
      const showAll = Vue.ref(false);
      let timer = null;

      function reload() { return store.loadReview().catch(() => {}); }
      function openReject(it) { rejectId.value = it.id; rejectText.value = ""; }
      function cancelReject() { rejectId.value = null; rejectText.value = ""; }

      async function decide(it, action) {
        if (busy.value) return;
        let reason = "";
        if (action === "reject") {
          reason = String(rejectText.value || "").trim();
          if (!reason) { store.toast("打回要先写明打回理由", "warn"); return; }
        }
        busy.value = it.id;
        try {
          delete stale[it.id];
          await store.decideReview(it, action, reason);
          if (action === "reject") cancelReject();
        } catch (e) {
          if (e && e.code === "STALE") stale[it.id] = e;
        } finally { busy.value = null; }
      }
      function retryItem(it) { delete stale[it.id]; reload(); }

      /* 受控要素弹窗（2026-11-21）：首帧＋IR 提示词——复审时知道这条片怎么被控制 */
      function esc(s) { return String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
      function showPrompt(it) {
        T.store.openSheet({
          title: (it.seq ? "镜 " + ((it.seq % 100 < 10 ? "0" : "") + (it.seq % 100)) : it.id) + " · 受控要素",
          rows: [
            "首帧（I2V 输入 · 锁人脸/构图/服装）：" + (it.first_frame || "—"),
            "IR：" + (it.ir_llm_used === true ? "经 LLM 重写" : it.ir_llm_used === false ? "规则拼装" : "—")
          ],
          html: "<div style='font-size:12px;margin-top:6px'><b>最终下发的提示词（IR）</b></div>" +
            "<pre style='white-space:pre-wrap;font-size:12px;line-height:1.5;background:#f6f7f9;padding:10px;border-radius:8px;max-height:320px;overflow:auto'>" + esc(it.prompt) + "</pre>",
          actions: [{ label: "知道了", kind: "btn-ghost", onClick: c => c() }]
        });
      }

      Vue.onMounted(() => {
        reload();
        /* SSE review 事件由骨架自动重取；这里加 5s 轮询兜底 */
        timer = setInterval(() => {
          if (!store.review.loading && !busy.value) store.loadReview().catch(() => {});
        }, 5000);
      });
      Vue.onUnmounted(() => { clearInterval(timer); });

      return {
        busy, rejectId, rejectText, stale, showAll,
        queueView: Vue.computed(() => {
          const q = store.review.queue || [];
          return showAll.value ? q : q.filter(x => String(x.status || "pending") === "pending");
        }),
        queue: Vue.computed(() => store.review.queue),
        pending: Vue.computed(() => store.review.pending || 0),
        loading: Vue.computed(() => store.review.loading),
        err: Vue.computed(() => store.review.error),
        reload, openReject, cancelReject, decide, retryItem, showPrompt,
        stOf: it => RQ_STATE[String(it.status || "pending").toLowerCase()] || RQ_STATE.pending,
        /* 统一镜号（2026-11-21）：「镜 03 · 卧室·夜 · 7.5s」＋重拍条次「第 N 条」——
           同镜多条送审靠条次+送审时间+缩略区分，不再出现只有哈希尾数的「鬼都不认得」条目 */
        shotLabel: it => {
          if (it.seq) {
            const base = T.shotFull({ seq: it.seq, name: it.shotName, sec: it.sec });
            return it.takeNo && it.takeNo > 1 ? base + " · 第 " + it.takeNo + " 条" : base;
          }
          return "镜 " + String(it.shotId || "").slice(-6);
        },
        shotNo: it => { const m = String(it.shotId || "").match(/(\d+)\s*$/); return m ? m[1] : "—"; },
        clean: s => T.sanitize(s),
        sla: it => slaText(it.sla_left),
        hs: s => T.sanitize(s),
        thumbStyle: it => {
          const h = hueOf(String(it.shotId || it.id));
          return { background: "linear-gradient(135deg, hsl(" + h + ",42%,78%), hsl(" + ((h + 40) % 360) + ",38%,60%))" };
        }
      };
    }
  };
})(window);
