/* 剧场 Studio · 拍摄墙视图（视图 Agent A）
   路由：#/ep/:id/shoot（props epId）。数据双份：store.state.shots_by_episode[epId]（16 镜）
   ＋store.loadJobs（SSE jobs 事件骨架就地更新，本视图另设 4s 轮询兜底，onUnmounted 清理）。
   纪律：全中文人话；引擎型号名不进模板字面量（出 store 后再经 T.sanitize 包一层；
   任务账本里的 lane/worker_type 是内部代号，一律不上屏）；金额 <b class=num>（Money 组件）。
   BACKEND-ISSUE: GET /api/jobs?episodeId= 实测（冒烟服 8767）落到 store.readLog("job") 账本：
     行形状 {id:log_xxx, ts, job_id, worker_type, type, lane, status, episodeId, initiated_by,
     free, attempts}，没有 payload，且同一 job_id 按状态变迁有多行。后果：①任务无法归属到具体
     镜头（payload.shotId 缺失），镜格内的「停/重拍」按钮只能在任务带 payload.shotId 时点亮，
     当前以集级「队列任务」区兜底给 stop/retry（retry 404 属正常，store 已有人话 toast）；
     ②操作必须传 job_id（传行 id 会 404），视图已按 job_id 取键并按 ts 去重取最新行。
   BACKEND-ISSUE: shots.status 永不为 "failed"（video 任务失败后镜头仍停在 pending/moderating），
     failed 高亮只能来自 failed 的 video 任务行；若后端把失败回写到镜头状态，镜格高亮自动跟上。
   BACKEND-ISSUE: 种子镜名带「PROTO·」前缀（用户面忌词），建议数据侧清理；视图 clean() 已遮罩。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const views = (global.__VIEWS = global.__VIEWS || {});

  /* 出 store 的字段再包一层语言表；顺带遮掉种子镜名里的「PROTO」前缀（数据侧忌词，见 BACKEND-ISSUE） */
  function clean(s) {
    let x = T.sanitize(s == null ? "" : String(s));
    x = x.replace(/演示/g, "备选").replace(/\bdemos?\b/gi, "备选");
    x = x.replace(/PROTO[·・．.:：\-]*\s?/gi, "");
    x = x.replace(/TTS\s*stub/gi, "合成语音").replace(/[（(]\s*stub\s*[)）]/gi, "").replace(/\bstub\b/gi, "");
    return x.replace(/[ \t]{2,}/g, " ").replace(/\s+([）)）])/, "$1").trim();
  }

  /* 任务类型的人话名（不上任何内部代号/型号）——表必须覆盖全部 type，漏一个就漏英文 */
  const JOB_TYPE_CN = {
    c1plan: "故事策划", storyboard: "分镜绘制", storyboard_char: "分镜出图",
    casting: "选角", cast_init: "角色定妆", screen_test: "试妆试镜",
    video: "镜头拍摄", moderate: "机审", aireview: "AI 审查",
    compose: "合成", music: "配乐", voice: "配音"
  };

  views.Shoot = {
    props: { epId: { type: String, required: true } },
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "money": T.components.Money,
      "time-ago": T.components.TimeAgo,
      "status-dot": T.components.StatusDot,
      "loading": T.components.Loading
    },
    setup(props) {
      const Vue = global.Vue;
      const ref = Vue.ref, computed = Vue.computed;
      const opBusy = ref("");

      const shots = computed(() => {
        const s = store.state;
        const m = s && s.shots_by_episode;
        return (m && Array.isArray(m[props.epId])) ? m[props.epId] : null;
      });
      const loading = computed(() => !store.state && store.loading.state);
      const err = computed(() => (!store.state ? store.err.state : null));
      const isEmpty = computed(() => !loading.value && !err.value && Array.isArray(shots.value) && shots.value.length === 0);
      const wallErr = computed(() => (store.jobs.epId === props.epId ? store.jobs.error : null));

      /* 账本按 job_id 去重取最新行（同任务多行状态变迁） */
      const jobRows = computed(() => {
        const raw = (store.jobs.epId === props.epId && Array.isArray(store.jobs.list)) ? store.jobs.list : [];
        const map = new Map();
        raw.forEach(r => {
          if (!r) return;
          const k = String(r.job_id != null ? r.job_id : r.id);
          const cur = map.get(k);
          if (!cur || Number(r.ts || 0) >= Number(cur.ts || 0)) map.set(k, r);
        });
        return Array.from(map.values()).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
      });
      const jobOf = shot => jobRows.value.find(j => j.live !== false && (j.shotId === shot.id || (j.payload && j.payload.shotId === shot.id))) || null;
      const jobFailed = shot => {
        const j = jobOf(shot);
        return !!j && j.status === "failed";
      };
      /* 镜格状态色带（纯展示映射，不改任何状态）：ok 绿 / run 蓝 / queued 灰 / 复审黄 / 失败红 */
      function cellCls(shot) {
        const failed = jobFailed(shot);
        const j = jobOf(shot);
        const jst = j ? String(j.status) : "";
        const cls = {
          "v-shoot-warn": String(shot.status) === "pending_review",
          "v-shoot-err": failed,
          "v-shoot-run": !failed && !!j && ["queued", "running"].indexOf(jst) >= 0
        };
        let band = "v-shoot-band-q";
        if (failed) band = "v-shoot-band-err";
        else if (String(shot.status) === "pending_review") band = "v-shoot-band-warn";
        else if (jst === "running") band = "v-shoot-band-run";
        else if (jst === "failed") band = "v-shoot-band-err";
        else if (String(shot.status) === "ok") band = "v-shoot-band-ok";
        cls[band] = true;
        return cls;
      }
      /* 集级任务区：只列**存活**任务（live!==false——引擎重启后账本里的 running/queued 是残影，
         2026-11-21「僵死假象」修复）；成功归档不打扰，历史在时间线看。
         排序＝真实执行顺序（2026-11-21「不知所谓」修复：原先按时间倒序，行序全反、
         「前面还有 N 个」算反、下一步说错镜头）：running 在最上，queued/pending 同车道
         内按入队时间升序（＝lane FIFO，车道间并行无先后），failed 垫底（最新在前）。 */
      const STATUS_RANK = { running: 0, queued: 1, pending: 1, failed: 2 };
      function jobTs(j) { return Number(j.ts != null ? j.ts : (j.at != null ? j.at : 0)); }
      const queueJobs = computed(() => {
        const act = jobRows.value.filter(j => j.live !== false && STATUS_RANK[String(j.status)] != null);
        return act.slice().sort((a, b) => {
          const ra = STATUS_RANK[String(a.status)] || 0, rb = STATUS_RANK[String(b.status)] || 0;
          if (ra !== rb) return ra - rb;
          if (ra === 2) return jobTs(b) - jobTs(a);
          const la = String(a.lane || ""), lb = String(b.lane || "");
          if (la !== lb) return la < lb ? -1 : 1;
          return jobTs(a) - jobTs(b);
        });
      });
      const queuedN = computed(() => jobRows.value.filter(j => ["queued", "pending"].indexOf(String(j.status)) >= 0).length);
      const runningN = computed(() => jobRows.value.filter(j => String(j.status) === "running").length);
      const totalN = computed(() => (shots.value || []).length || 16);
      const doneN = computed(() => (shots.value || []).filter(s => String(s.status) === "ok").length);
      const reviewN = computed(() => (shots.value || []).filter(s => String(s.status) === "pending_review").length);
      const failedN = computed(() => jobRows.value.filter(j => j.live !== false && String(j.status) === "failed").length);

      /* ---- 状态过滤（2026-11-21「点不住」修复）：toolbar 统计原是纯展示数字，用户当 tab 点
         点不动。现做成真过滤器：点状态 chip → 镜头墙与队列按状态过滤；再点一次取消。 ---- */
      const filter = ref("");
      function setFilter(f) { filter.value = filter.value === f ? "" : f; }
      function matchShot(s) {
        const f = filter.value;
        if (!f) return true;
        const j = jobOf(s);
        if (f === "queued") return !!j && ["queued", "pending"].indexOf(String(j.status)) >= 0;
        if (f === "running") return !!j && String(j.status) === "running";
        if (f === "failed") return (!!j && String(j.status) === "failed") || !!(s.flags && s.flags.stale);
        if (f === "review") return String(s.status) === "pending_review";
        if (f === "ok") return String(s.status) === "ok";
        return true;
      }
      const wallShots = computed(() => (shots.value || []).filter(matchShot));
      const queueJobsF = computed(() => {
        const f = filter.value;
        if (!f || f === "review" || f === "ok") return queueJobs.value; // 全部/复审/完成态下队列保持全览
        return queueJobs.value.filter(j => String(j.status) === f || (f === "queued" && ["queued", "pending"].indexOf(String(j.status)) >= 0));
      });

      function takeCost(shot) {
        const tk = shot.takes || [];
        let sum = 0;
        tk.forEach(t => { sum += Number(t && t.cost_cents) || 0; });
        return sum;
      }
      /* 受控要素弹窗（2026-11-21「视频怎么受控」）：首帧（锁人脸/构图）＋模板＋种子＋最终 IR 提示词 */
      function esc(s) { return String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
      function showPrompt(j, s) {
        const m = (j.result && j.result.meta) || {};
        store.openSheet({
          title: (s ? T.shotLabel(s) : jobId(j)) + " · 受控要素",
          rows: [
            "首帧（I2V 输入 · 锁人脸/构图/服装）：" + (j.first_frame || "无（参考图模式）"),
            "渲染模板：" + (j.tmpl_id || m.tmpl_id || "—") + (m.ir_llm_used === true ? " · IR 经 LLM 重写" : " · IR 规则拼装"),
            "种子：" + (m.seed || "—")
          ],
          html: "<div style='font-size:12px;margin-top:6px'><b>最终下发的提示词（IR）</b></div>" +
            "<pre style='white-space:pre-wrap;font-size:12px;line-height:1.5;background:#f6f7f9;padding:10px;border-radius:8px;max-height:320px;overflow:auto'>" + esc(j.prompt) + "</pre>",
          actions: [{ label: "知道了", kind: "btn-ghost", onClick: c => c() }]
        });
      }
      function jobLabel(j) {
        return JOB_TYPE_CN[String(j.type || "").toLowerCase()] || clean(j.type || "任务");
      }
      function jobId(j) { return String(j.job_id != null ? j.job_id : j.id); }

      /* ---- 队列可读化（2026-11-21 二轮）：镜号＋镜名 / 排队第 N 位（同车道真实顺序） /
         已等时长（活行 ts 由服务端从账本补齐，running 行＝开拍时刻） / 看片 ---- */
      const EST_MIN_PER_SHOT = 7; // H3 单镜实测均值（187帧 ≈ 7 分钟）
      function shotOf(j) {
        const sid = j.shotId || (j.payload && j.payload.shotId) || null;
        return sid ? (shots.value || []).find(s => s.id === sid) || null : null;
      }
      function jobShotTag(j) {
        const s = shotOf(j);
        if (!s) return jobLabel(j);
        return T.shotFull(s) + ((s.takes || []).length > 1 ? " · 第 " + (s.takes || []).length + " 条" : "");
      }
      function jobWaitMin(j) {
        const ts = jobTs(j);
        if (!ts) return 0;
        return Math.max(0, Math.round((Date.now() - ts) / 60000));
      }
      /* 同车道排队位次（车道间并行，「前面还有」只数本车道；display 序＝真实 FIFO） */
      function laneQueued(j) {
        const lane = String(j.lane || "");
        return queueJobs.value.filter(x => String(x.lane || "") === lane && ["queued", "pending"].indexOf(String(x.status)) >= 0);
      }
      function queuePos(j) {
        const q = laneQueued(j);
        return Math.max(0, q.findIndex(x => jobId(x) === jobId(j))) + 1;
      }
      function queuedAhead(j) { return queuePos(j) - 1; }
      function jobStateCn(j) {
        const st = String(j.status || "");
        if (st === "running") {
          const w = jobWaitMin(j);
          return "拍摄渲染中 · 已 " + w + " 分钟" + (w > EST_MIN_PER_SHOT ? "（略慢于均值 " + EST_MIN_PER_SHOT + " 分钟/镜，继续等）" : "（预计约 " + EST_MIN_PER_SHOT + " 分钟/镜）");
        }
        /* 状态点已带「排队中/失败」标签，正文不再重复 */
        if (st === "queued" || st === "pending") return "前面还有 " + queuedAhead(j) + " 个（自动依次渲染，约 " + EST_MIN_PER_SHOT + " 分钟/镜）";
        if (st === "failed") return "原因：" + clean(String(j.error || "未知，可点「重拍」再试").slice(0, 80));
        if (st === "cancelled") return "已取消";
        return st;
      }
      function jobTakeArt(j) {
        const s = shotOf(j);
        const tk = s && s.takes && s.takes.length ? s.takes[s.takes.length - 1] : null;
        return tk && tk.art ? "/" + tk.art : null;
      }
      /* 下一步（自动链预测）：渲染中 → 排队镜 → 自动机审 → 灰区批复 → 混流
         （queueJobs 已按真实执行顺序排，q[0] 才是真正下一个） */
      const nextStep = computed(() => {
        const run = queueJobs.value.find(j => String(j.status) === "running");
        const q = queueJobs.value.filter(j => ["queued", "pending"].indexOf(String(j.status)) >= 0);
        const tag = (j) => {
          const s = shotOf(j);
          if (!s) return jobLabel(j);
          return "#" + (s.seq % 100 || s.seq) + " " + (clean(s.name) || "镜");
        };
        if (run) return "正在拍 " + tag(run) + (q.length ? "；下一个自动排 " + tag(q[0]) : "");
        if (q.length) return "下一个拍 " + tag(q[0]);
        if (reviewN.value) return "等待你批复灰区镜（复审台）";
        if (doneN.value >= totalN.value) return "全部镜头完成 → 自动混流成片（交付页）";
        return "等待任务";
      });

      async function stop(j) {
        if (opBusy.value) return;
        opBusy.value = "stop-" + jobId(j);
        try { await store.stopJob(jobId(j)); } catch (e) { /* store 已 toast 人话 */ }
        finally { opBusy.value = ""; }
      }
      async function retry(j) {
        if (opBusy.value) return;
        opBusy.value = "retry-" + jobId(j);
        try { await store.retryJob(jobId(j)); } catch (e) { /* store 已 toast 人话 */ }
        finally { opBusy.value = ""; }
      }

      function reload() {
        store.refreshState().catch(() => {});
        store.loadJobs(props.epId).catch(() => {});
      }
      function goFlow() {
        global.__ROUTER.go(global.__ROUTER.ep("flow", props.epId));
      }

      let timer = null;
      Vue.onMounted(() => {
        store.refreshState().catch(() => {});
        store.loadJobs(props.epId).catch(() => {});
        timer = setInterval(() => { store.loadJobs(props.epId).catch(() => {}); }, 4000);
      });
      Vue.onUnmounted(() => { if (timer) clearInterval(timer); timer = null; });

      return {
        store, opBusy, shots, loading, err, isEmpty, wallErr,
        jobRows, queueJobs, queueJobsF, wallShots, filter, setFilter, failedN,
        queuedN, runningN, totalN, doneN, reviewN,
        jobOf, jobFailed, cellCls, takeCost, jobLabel, jobId, stop, retry, reload, goFlow, clean,
        jobShotTag, jobStateCn, jobTakeArt, jobWaitMin, nextStep, queuePos, showPrompt,
        shotLabel: s => T.shotLabel(s)
      };
    },
    template: `
      <div class="v-shoot">
        <div class="toolbar">
          <button class="btn btn-sm" :class="filter === '' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('')">全部 <b class="num">{{ doneN }}</b><span class="muted">/</span><b class="num">{{ totalN }}</b></button>
          <span class="tb-sep"></span>
          <button class="btn btn-sm" :class="filter === 'queued' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('queued')">排队 <b class="num">{{ queuedN }}</b></button>
          <span class="tb-sep"></span>
          <button class="btn btn-sm" :class="filter === 'running' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('running')">在拍 <b class="num">{{ runningN }}</b></button>
          <span class="tb-sep"></span>
          <button class="btn btn-sm" :class="filter === 'review' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('review')">待复审 <b class="num">{{ reviewN }}</b></button>
          <span class="tb-sep"></span>
          <button class="btn btn-sm" :class="filter === 'ok' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('ok')">已完成 <b class="num">{{ doneN }}</b></button>
          <button class="btn btn-sm" v-if="failedN" :class="filter === 'failed' ? 'btn-primary' : 'btn-ghost'" @click="setFilter('failed')">失败 <b class="num">{{ failedN }}</b></button>
          <span class="grow"></span>
          <span class="weak">点状态过滤镜头与队列 · 再点一次取消 · 灰区镜头自动送复审台</span>
        </div>

        <loading v-if="loading"></loading>
        <err-state v-else-if="err" :err="err" :on-retry="reload"></err-state>
        <empty-state v-else-if="isEmpty" icon="🎞" text="这一集还没有镜头"
          sub="先去创作卡流把「方向」卡拍板，16 镜会自动排进拍摄墙">
          <button class="btn btn-primary btn-sm" @click="goFlow">去拍方向卡</button>
        </empty-state>

        <template v-else>
          <div class="wall">
            <div v-for="s in wallShots" :key="s.id" class="card v-shoot-cell" :class="cellCls(s)">
              <div class="row">
                <b class="num v-shoot-seq">{{ shotLabel(s) }}</b>
                <span class="grow v-shoot-name" :title="clean(s.name)">{{ clean(s.name) }}</span>
                <span class="muted"><b class="num">{{ s.sec }}</b> 秒</span>
              </div>
              <div class="row v-shoot-meta">
                <status-dot :status="s.status"></status-dot>
                <span>条数 <b class="num">{{ (s.takes || []).length }}</b></span>
                <span>成本 <money :cents="takeCost(s)"></money></span>
              </div>
              <div class="row v-shoot-meta" v-if="jobOf(s)">
                <status-dot :status="jobOf(s).status"></status-dot>
                <span class="muted">{{ jobStateCn(jobOf(s)) }}</span>
                <span v-if="jobOf(s).attempts">第 <b class="num">{{ jobOf(s).attempts }}</b> 次尝试</span>
              </div>
              <div class="row v-shoot-acts" v-if="(s.takes || []).length && s.takes[s.takes.length - 1].art">
                <a class="btn btn-sm" :href="'/' + s.takes[s.takes.length - 1].art" target="_blank">▶ 看最新片</a>
              </div>
              <div class="row v-shoot-acts" v-if="jobOf(s)">
                <button class="btn btn-sm btn-ghost" v-if="jobOf(s).prompt" @click="showPrompt(jobOf(s), s)">📋 受控要素</button>
                <button class="btn btn-sm" v-if="['queued','running'].indexOf(String(jobOf(s).status)) >= 0"
                  :disabled="opBusy === ('stop-' + jobId(jobOf(s)))" @click="stop(jobOf(s))">停</button>
                <button class="btn btn-sm btn-danger" v-if="String(jobOf(s).status) === 'failed'"
                  :disabled="opBusy === ('retry-' + jobId(jobOf(s)))" @click="retry(jobOf(s))">重拍</button>
              </div>
            </div>
          </div>

          <!-- 集级队列：可读化（真实执行顺序 · 镜号＋镜名 · 排队位次 · 已等时长 · 看片） -->
          <err-state v-if="wallErr" :err="wallErr" :on-retry="reload" compact></err-state>
          <div class="panel" v-if="queueJobsF.length">
            <div class="panel-title">拍摄队列
              <span class="badge badge-ok">下一步：{{ nextStep }}</span>
              <span class="weak">从上往下依次自动拍摄；渲染完自动机审，灰区镜会送你批复</span>
            </div>
            <div class="list">
              <div class="list-item row wrap v-shoot-q"
                :class="{ 'v-shoot-q-run': String(j.status) === 'running', 'v-shoot-q-fail': String(j.status) === 'failed' }"
                v-for="j in queueJobsF" :key="jobId(j)">
                <status-dot :status="j.status"></status-dot>
                <span class="v-shoot-q-pos is-run" v-if="String(j.status) === 'running'">正在拍</span>
                <span class="v-shoot-q-pos" v-else-if="['queued','pending'].indexOf(String(j.status)) >= 0">第 {{ queuePos(j) }} 位</span>
                <b>{{ jobShotTag(j) }}</b>
                <span class="muted">{{ jobStateCn(j) }}</span>
                <span class="muted" v-if="j.attempts > 0">（第 <b class="num">{{ j.attempts + 1 }}</b> 次尝试）</span>
                <a v-if="jobTakeArt(j)" :href="jobTakeArt(j)" target="_blank" style="text-decoration:underline">▶ 看片</a>
                <button class="btn btn-sm btn-ghost" v-if="j.prompt" @click="showPrompt(j, shotOf(j))">📋</button>
                <span class="grow"></span>
                <button class="btn btn-sm"
                  v-if="['queued','running'].indexOf(String(j.status)) >= 0"
                  :disabled="opBusy === ('stop-' + jobId(j))" @click="stop(j)">停</button>
                <button class="btn btn-sm btn-danger" v-if="String(j.status) === 'failed'"
                  :disabled="opBusy === ('retry-' + jobId(j))" @click="retry(j)">重拍</button>
              </div>
            </div>
          </div>
        </template>
      </div>`
  };
})(window);
