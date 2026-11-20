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

  /* 任务类型的人话名（不上任何内部代号/型号） */
  const JOB_TYPE_CN = {
    c1plan: "故事策划", storyboard: "分镜绘制", video: "镜头拍摄",
    moderate: "机审", compose: "合成", music: "配乐", voice: "配音"
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
      const jobOf = shot => jobRows.value.find(j => j.payload && j.payload.shotId === shot.id) || null;
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
      /* 集级任务区：只列还在跑/排队/失败的（成功归档不打扰） */
      const queueJobs = computed(() =>
        jobRows.value.filter(j => ["queued", "pending", "running", "failed"].indexOf(String(j.status)) >= 0)
      );
      const queuedN = computed(() => jobRows.value.filter(j => ["queued", "pending"].indexOf(String(j.status)) >= 0).length);
      const runningN = computed(() => jobRows.value.filter(j => String(j.status) === "running").length);
      const totalN = computed(() => (shots.value || []).length || 16);
      const doneN = computed(() => (shots.value || []).filter(s => String(s.status) === "ok").length);
      const reviewN = computed(() => (shots.value || []).filter(s => String(s.status) === "pending_review").length);

      function takeCost(shot) {
        const tk = shot.takes || [];
        let sum = 0;
        tk.forEach(t => { sum += Number(t && t.cost_cents) || 0; });
        return sum;
      }
      function jobLabel(j) {
        return JOB_TYPE_CN[String(j.type || "").toLowerCase()] || clean(j.type || "任务");
      }
      function jobId(j) { return String(j.job_id != null ? j.job_id : j.id); }

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
        jobRows, queueJobs, queuedN, runningN, totalN, doneN, reviewN,
        jobOf, jobFailed, cellCls, takeCost, jobLabel, jobId, stop, retry, reload, goFlow, clean
      };
    },
    template: `
      <div class="v-shoot">
        <div class="toolbar">
          <span>完成 <b class="num">{{ doneN }}</b><span class="muted">/</span><b class="num">{{ totalN }}</b></span>
          <span class="tb-sep"></span>
          <span>排队 <b class="num">{{ queuedN }}</b></span>
          <span class="tb-sep"></span>
          <span>在拍 <b class="num">{{ runningN }}</b></span>
          <span class="tb-sep"></span>
          <span>待复审 <b class="num">{{ reviewN }}</b></span>
          <span class="grow"></span>
          <span class="weak">灰区镜头自动送复审台</span>
        </div>

        <loading v-if="loading"></loading>
        <err-state v-else-if="err" :err="err" :on-retry="reload"></err-state>
        <empty-state v-else-if="isEmpty" icon="🎞" text="这一集还没有镜头"
          sub="先去创作卡流把「方向」卡拍板，16 镜会自动排进拍摄墙">
          <button class="btn btn-primary btn-sm" @click="goFlow">去拍方向卡</button>
        </empty-state>

        <template v-else>
          <div class="wall">
            <div v-for="s in shots" :key="s.id" class="card v-shoot-cell" :class="cellCls(s)">
              <div class="row">
                <b class="num v-shoot-seq">#{{ s.seq }}</b>
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
                <span v-if="jobOf(s).attempts">第 <b class="num">{{ jobOf(s).attempts }}</b> 次尝试</span>
              </div>
              <div class="row v-shoot-acts" v-if="jobOf(s)">
                <button class="btn btn-sm" v-if="['queued','running'].indexOf(String(jobOf(s).status)) >= 0"
                  :disabled="opBusy === ('stop-' + jobId(jobOf(s)))" @click="stop(jobOf(s))">停</button>
                <button class="btn btn-sm btn-danger" v-if="String(jobOf(s).status) === 'failed'"
                  :disabled="opBusy === ('retry-' + jobId(jobOf(s)))" @click="retry(jobOf(s))">重拍</button>
              </div>
            </div>
          </div>

          <!-- 集级队列：账本任务带不上镜号时的兜底操作区（见文件头 BACKEND-ISSUE） -->
          <err-state v-if="wallErr" :err="wallErr" :on-retry="reload" compact></err-state>
          <div class="panel" v-if="queueJobs.length">
            <div class="panel-title">队列任务
              <span class="weak">任务单暂未带镜号，这里统一给「停 / 重拍」</span>
            </div>
            <div class="list">
              <div class="list-item row wrap v-shoot-q" v-for="j in queueJobs" :key="jobId(j)">
                <span>{{ jobLabel(j) }}</span>
                <status-dot :status="j.status"></status-dot>
                <span class="muted" v-if="j.attempts">第 <b class="num">{{ j.attempts }}</b> 次</span>
                <time-ago :ts="j.ts"></time-ago>
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
