/* 剧场 Studio · 创作卡流视图（视图 Agent A）
   路由：#/ep/:id/flow（props epId）。数据：store.loadCards（SSE cards 事件骨架自动重取，
   本视图另设 5s 轮询兜底，onUnmounted 清理）；C6 卡另调 store.estimate 拉服务端报价。
   纪律：全中文人话；引擎型号名不进模板字面量（数据出 store 后再经 T.sanitize 包一层）；
   金额一律 <b class=num>（Money 组件负责）；只新增本文件，不动骨架。
   BACKEND-ISSUE: C9 候选的 art 字段是 "var/out/*.mp3" 相对路径，但服务端静态兜底只映射
     src/client（实测 GET /var/out/xxx.mp3 → 404，且 var/out 目录当前为空），「▶ 试听」
     无法出声。视图按契约仍用 audio 元素加载该路径，并在 error 事件里给人话提示；待服务端
     提供 /var 静态映射或可访问 URL 后即插即活。视图不拼引擎型号名进模板。
   BACKEND-ISSUE: 服务端数据里带了用户面忌词——music 候选兜底标题「未许可演示曲-…」、种子
     镜名「PROTO·…」。建议数据侧清理；视图 clean() 已做最后遮罩（演示→备选、去 PROTO 前缀）。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const views = (global.__VIEWS = global.__VIEWS || {});

  /* 卡片类型徽标（契约 §6 A：C1 方向/C2 选角/C3 美术/C4 样片/C5 节奏/C6 开机报价/C7 复审批复/C9 配乐提案/C8 交付确认） */
  const TYPE_META = {
    C1: { name: "方向", title: "故事方向" },
    C2: { name: "选角", title: "演员定妆" },
    C3: { name: "美术", title: "演员表锁定" },
    C4: { name: "样片", title: "分镜画面" },
    C5: { name: "节奏", title: "样片审看" },
    C6: { name: "开机报价", title: "开机确认" },
    C7: { name: "复审批复", title: "灰区镜头批复" },
    C8: { name: "交付确认", title: "全镜放行" },
    C9: { name: "配乐提案", title: "场景配乐候选" }
  };

  /* 直接拼进 DOM 的服务端字段统一再包一层语言表（对已消毒字段幂等）。
     额外兜掉服务端残留的用户面忌词：候选曲名里的「演示」与种子镜名里的「PROTO」前缀，
     均为数据侧治理范围，视图只做最后一道遮罩（见 BACKEND-ISSUE）。 */
  function clean(s) {
    let x = T.sanitize(s == null ? "" : String(s));
    x = x.replace(/演示/g, "备选").replace(/\bdemos?\b/gi, "备选");
    x = x.replace(/PROTO[·・．.:：\-]*\s?/gi, "");
    x = x.replace(/TTS\s*stub/gi, "合成语音").replace(/[（(]\s*stub\s*[)）]/gi, "").replace(/\bstub\b/gi, "");
    return x.replace(/[ \t]{2,}/g, " ").replace(/\s+([）)）])/, "$1").trim();
  }

  function srcOf(art) {
    const a = String(art || "");
    if (!a) return "";
    if (/^https?:\/\//i.test(a)) return a;
    return a.charAt(0) === "/" ? a : "/" + a;
  }

  views.Flow = {
    props: { epId: { type: String, required: true } },
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "money": T.components.Money,
      "time-ago": T.components.TimeAgo,
      "loading": T.components.Loading,
      "license-badge": T.components.LicenseBadge
    },
    setup(props) {
      const Vue = global.Vue;
      const ref = Vue.ref, reactive = Vue.reactive, computed = Vue.computed;
      const busyId = ref("");
      const editing = ref("");
      const noteText = ref("");
      const adopted = reactive({});
      const est = reactive({ data: null, loading: false, err: null });
      const shooting = ref(false);
      const playingId = ref("");
      const playingSrc = ref("");
      const audioErr = ref("");
      const audioEl = ref(null);

      const list = computed(() => (store.cards.epId === props.epId ? store.cards.list : null));
      const loading = computed(() => list.value === null && store.cards.loading);
      const err = computed(() => (list.value === null ? store.cards.error : null));
      const isEmpty = computed(() => !loading.value && !err.value && Array.isArray(list.value) && list.value.length === 0);
      const pendingCount = computed(() => (list.value || []).filter(c => c.status === "pending").length);
      const decidedCount = computed(() => (list.value || []).filter(c => c.status !== "pending").length);
      const ordered = computed(() => {
        const arr = (list.value || []).slice();
        const pen = arr.filter(c => c.status === "pending").sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        const dec = arr.filter(c => c.status !== "pending").sort((a, b) => (b.decided_at || 0) - (a.decided_at || 0));
        return pen.concat(dec);
      });
      /* C6 开机的前提：本集 C6 卡已拍板（后端 shoot 也强制校验） */
      const c6Decided = computed(() => (list.value || []).some(c => c.type === "C6" && c.status !== "pending"));
      const hasC6 = computed(() => (list.value || []).some(c => c.type === "C6"));

      function typeLabel(t) {
        const m = TYPE_META[t];
        return m ? t + " · " + m.name : clean(String(t || "创作卡"));
      }
      function cardTitle(card) {
        const m = TYPE_META[card.type];
        return m ? m.title : "创作卡";
      }
      /* payload 一句话摘要（全走 clean，绝不拼型号） */
      function summary(card) {
        const p = card.payload || {};
        switch (card.type) {
          case "C1": {
            const bits = [];
            if (p.summary) bits.push(clean(p.summary));
            if (Array.isArray(p.scenes)) bits.push("共 " + p.scenes.length + " 场");
            return bits.join(" · ");
          }
          case "C2": {
            const a = Array.isArray(p.actors) ? p.actors : [];
            if (!a.length) return clean(p.note || "");
            return "共 " + a.length + " 位角色 · 每位 " + ((a[0].candidates || []).length || 4) + " 个定妆候选";
          }
          case "C3": {
            const c = Array.isArray(p.cast) ? p.cast : [];
            return "定妆已锁 " + c.length + " 位" + (p.note ? " · " + clean(p.note) : "");
          }
          case "C4": {
            const im = Array.isArray(p.images) ? p.images : [];
            return "分镜画面 " + im.length + " 张" + (p.note ? " · " + clean(p.note) : "");
          }
          case "C5": {
            const a = p.art || {};
            const bits = ["样片已出"];
            if (a.resolution) bits.push(clean(a.resolution) + " 画幅");
            if (a.fps) bits.push(a.fps + " 帧");
            return bits.join(" · ");
          }
          case "C6": {
            const e = p.estimate || {};
            const bits = [];
            if (e.shots != null) bits.push(e.shots + " 镜");
            if (e.time_min != null) bits.push("约 " + clean(T.fmtMin(e.time_min)));
            if (e.cents != null) bits.push("总估 " + T.fmtYuan(e.cents));
            return bits.join(" · ");
          }
          case "C7": {
            const it = Array.isArray(p.items) ? p.items : [];
            return it.length + " 个镜头落了机审灰区，等你批复";
          }
          case "C8": {
            return clean(p.summary || "全部镜头审核通过") + (p.shots != null ? " · " + p.shots + " 镜" : "");
          }
          case "C9": {
            const c = Array.isArray(p.candidates) ? p.candidates : [];
            return (p.mood ? clean(p.mood) + " · " : "") + c.length + " 条候选（影子计费）";
          }
          default:
            return clean(p.summary || p.note || "");
        }
      }
      /* C7 复审清单：镜号＋理由（镜号尽力从 state 里查 seq，查不到退到短号） */
      function c7Items(card) {
        const p = card.payload || {};
        const items = Array.isArray(p.items) ? p.items : [];
        const shots = (store.state && store.state.shots_by_episode && store.state.shots_by_episode[props.epId]) || [];
        return items.map(it => {
          const sh = shots.find(x => x.id === it.shotId);
          return {
            seq: sh ? sh.seq : null,
            short: String(it.shotId || "").slice(-4),
            reason: clean(it.reason || "机审建议人工复审")
          };
        });
      }
      function cands(card) {
        const p = card.payload || {};
        return Array.isArray(p.candidates) ? p.candidates : [];
      }

      async function decide(card, action, payload) {
        if (busyId.value) return;
        busyId.value = card.id;
        try { await store.decideCard(card, action, payload); }
        catch (e) { /* 人话提示由 store 统一 toast（含 STALE→模态） */ }
        finally { busyId.value = ""; }
      }
      const accept = card => decide(card, "accept");
      const reject = card => decide(card, "reject");
      function openNote(card) {
        if (editing.value === card.id) { editing.value = ""; return; }
        editing.value = card.id;
        noteText.value = "";
      }
      function editSubmit(card) {
        const note = noteText.value.trim();
        if (!note) return;
        editing.value = "";
        decide(card, "edit", { note });
      }

      /* ---- C6：服务端报价 + 开机 ---- */
      async function loadEstimate() {
        est.loading = true; est.err = null;
        try { est.data = await store.estimate(props.epId); }
        catch (e) { est.err = e; }
        finally { est.loading = false; }
      }
      async function startShoot() {
        if (shooting.value || !est.data) return;
        shooting.value = true;
        try {
          const r = await store.shoot(props.epId, est.data);
          if (r) store.loadJobs(props.epId).catch(() => {});
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { shooting.value = false; }
      }

      /* ---- C9：试听 / 用这条 / 换一批 ---- */
      function pauseAudio() {
        const el = audioEl.value;
        if (el) { try { el.pause(); } catch (e) {} }
        playingId.value = "";
      }
      async function play(c) {
        if (!c || !c.art) return;
        if (playingId.value === c.id) { pauseAudio(); return; }
        audioErr.value = "";
        playingId.value = c.id;
        playingSrc.value = srcOf(c.art);
        await Vue.nextTick();
        const el = audioEl.value;
        if (!el) return;
        try {
          el.load();
          const p = el.play();
          if (p && p.catch) p.catch(() => { audioErr.value = "这条听不了：音频文件还没落盘"; playingId.value = ""; });
        } catch (e) { audioErr.value = "这条听不了：音频文件还没落盘"; playingId.value = ""; }
      }
      async function useTrack(card, c) {
        if (busyId.value || adopted[c.id]) return;
        busyId.value = "mus-" + c.id;
        try {
          await store.adoptMusic(c.id, (card.payload || {}).sceneId);
          adopted[c.id] = true;
          store.loadCards(props.epId).catch(() => {});
        } catch (e) { /* store 已 toast 人话 */ }
        finally { busyId.value = ""; }
      }
      async function regen(card) {
        const first = cands(card)[0];
        if (busyId.value || !first) return;
        busyId.value = "regen-" + card.id;
        try { await store.regenMusic(first.id); }
        catch (e) { /* store 已 toast 人话 */ }
        finally { busyId.value = ""; }
      }

      function reload() { return store.loadCards(props.epId); }

      let timer = null;
      Vue.onMounted(() => {
        Promise.resolve(reload()).then(() => {
          if (hasC6.value && !est.data && !est.loading) loadEstimate();
        }).catch(() => {});
        timer = setInterval(() => { store.loadCards(props.epId).catch(() => {}); }, 5000);
      });
      Vue.onUnmounted(() => {
        if (timer) clearInterval(timer);
        timer = null;
        pauseAudio();
      });

      return {
        store, busyId, editing, noteText, adopted, est, shooting,
        playingId, playingSrc, audioErr, audioEl,
        list, loading, err, isEmpty, pendingCount, decidedCount, ordered, c6Decided,
        typeLabel, cardTitle, summary, c7Items, cands,
        clean, fmtMin: T.fmtMin,
        accept, reject, openNote, editSubmit,
        loadEstimate, startShoot, play, useTrack, regen, reload, pauseAudio
      };
    },
    template: `
      <div class="v-flow">
        <div class="toolbar">
          <span>待拍板 <b class="num">{{ pendingCount }}</b></span>
          <span class="tb-sep"></span>
          <span>已拍板 <b class="num">{{ decidedCount }}</b></span>
          <span class="grow"></span>
          <button class="btn btn-ghost btn-sm" @click="reload">刷新卡片</button>
        </div>

        <loading v-if="loading"></loading>
        <err-state v-else-if="err" :err="err" :on-retry="reload"></err-state>
        <empty-state v-else-if="isEmpty" icon="🎬" text="本集还没有创作卡"
          sub="回项目工作区开一集新剧，方向卡会自己流进来">
          <a class="btn btn-primary btn-sm" href="#/home">去开新集</a>
        </empty-state>

        <div v-else class="list v-flow-list">
          <div v-for="card in ordered" :key="card.id" class="card pcard"
            :class="{ 'v-flow-pending': card.status === 'pending', 'decided': card.status !== 'pending' }">
            <div class="card-head">
              <span class="badge v-flow-badge" :class="'v-flow-t-' + card.type">{{ typeLabel(card.type) }}</span>
              <span class="card-title">{{ cardTitle(card) }}</span>
              <span class="badge" :class="card.status === 'pending' ? 'badge-warn' : 'badge-ok'">
                {{ card.status === 'pending' ? '待拍板' : '已拍板' }}
              </span>
              <span class="grow"></span>
              <time-ago v-if="card.status !== 'pending' && card.decided_at" :ts="card.decided_at"></time-ago>
            </div>

            <div class="card-sub" v-if="summary(card)">{{ summary(card) }}</div>

            <!-- C7：复审清单（镜号＋理由） -->
            <div class="kv v-flow-c7" v-if="card.type === 'C7'">
              <div class="kv-row" v-for="(it, i) in c7Items(card)" :key="i">
                <span>镜 #{{ it.seq != null ? it.seq : ('…' + it.short) }}</span>
                <span class="weak">{{ it.reason }}</span>
              </div>
            </div>

            <!-- C9：候选单行（标题＋时长＋影子成本＋许可），操作只给待拍板卡 -->
            <div class="v-flow-c9" v-if="card.type === 'C9'">
              <div class="row v-flow-c9-row" v-for="c in cands(card)" :key="c.id">
                <span class="grow v-flow-c9-title" :title="clean(c.title)">{{ clean(c.title) }}</span>
                <span class="muted">{{ c.mood ? clean(c.mood) + ' · ' : '' }}<b class="num">{{ c.sec }}</b> 秒</span>
                <money :cents="c.shadow_cents"></money>
                <license-badge :license="c.license"></license-badge>
                <template v-if="card.status === 'pending'">
                  <button class="btn btn-sm" :disabled="!c.art"
                    :title="c.art ? '试听这条候选' : '这条候选还没有可用的音频文件，暂时听不了'"
                    @click="play(c)">{{ playingId === c.id ? '■ 停' : '▶ 试听' }}</button>
                  <span class="badge" v-if="adopted[c.id]">已采用 ✓</span>
                  <button v-else class="btn btn-sm btn-primary" :disabled="busyId === ('mus-' + c.id)"
                    @click="useTrack(card, c)">用这条</button>
                </template>
                <span class="badge" v-else-if="adopted[c.id]">已采用 ✓</span>
              </div>
              <div class="row wrap v-flow-acts" v-if="card.status === 'pending'">
                <button class="btn btn-sm btn-ghost" :disabled="!cands(card).length || busyId === ('regen-' + card.id)"
                  @click="regen(card)">换一批</button>
                <span class="weak" v-if="audioErr">{{ audioErr }}</span>
              </div>
            </div>

            <!-- C6：服务端报价明细（明细收进 kv，开机按钮在卡底部操作行） -->
            <div class="kv v-flow-est" v-if="card.type === 'C6'">
              <loading v-if="est.loading"></loading>
              <template v-else-if="est.data">
                <div class="kv-row"><span>镜头数</span><b class="num">{{ est.data.shots }}</b></div>
                <div class="kv-row"><span>预计耗时</span><b class="num">{{ fmtMin(est.data.time_min) }}</b></div>
                <div class="kv-row"><span>总估价</span><money :cents="est.data.cents"></money></div>
                <hr class="sep" />
                <div class="kv-row" v-for="(b, i) in (est.data.breakdown || [])" :key="i">
                  <span class="grow">{{ clean(b.item) }}</span>
                  <span class="muted">{{ b.unit }} × {{ b.qty }}</span>
                  <money :cents="b.cents"></money>
                </div>
              </template>
              <err-state v-else-if="est.err" :err="est.err" :on-retry="loadEstimate" compact></err-state>
            </div>
            <div class="row wrap v-flow-cta" v-if="card.type === 'C6'">
              <button class="btn btn-primary" :disabled="!est.data || est.loading || !c6Decided || shooting"
                :aria-busy="shooting ? 'true' : null" @click="startShoot">开机 🎬</button>
              <span class="weak" v-if="!c6Decided">先点「就这个」确认报价，才能开机。</span>
              <span class="weak" v-else-if="!est.data && !est.loading && !est.err">报价加载中…</span>
            </div>

            <!-- 主操作 -->
            <div class="row wrap v-flow-acts" v-if="card.status === 'pending'">
              <button class="btn btn-primary btn-sm" :disabled="busyId === card.id" @click="accept(card)">就这个</button>
              <button class="btn btn-sm" :disabled="busyId === card.id" @click="openNote(card)">让它改改</button>
              <button class="btn btn-sm btn-danger" :disabled="busyId === card.id" @click="reject(card)">重出一版</button>
            </div>
            <div class="weak" v-if="card.status === 'pending' && card.type === 'C1'">
              「重出一版」会重新派生方向，影子成本照常入账。
            </div>

            <div class="v-flow-note" v-if="editing === card.id">
              <textarea class="textarea" rows="2" v-model="noteText"
                placeholder="写下你想改的地方，比如：把结尾改成开放式收场"></textarea>
              <div class="row">
                <button class="btn btn-primary btn-sm" :disabled="!noteText.trim() || busyId === card.id"
                  @click="editSubmit(card)">递修改意见</button>
                <button class="btn btn-sm btn-ghost" @click="editing = ''">先不了</button>
              </div>
            </div>
          </div>
        </div>

        <audio ref="audioEl" :src="playingSrc" preload="none" style="display:none"
          @error="audioErr = '这条听不了：音频文件还没落盘'; playingId = ''"></audio>
      </div>`
  };
})(window);
