/* 剧场 Studio · 首页视图（视图 C 负责）
   2026-11-21 按 S2「首页·四入口+模板流」重排（theater-ui-interaction-design §4 四态）：
   ① 拍板横幅（有未批必答卡）→ ② 继续创作行 → ③ 吸顶输入框（一句话/小说）＋四入口磁贴
   → ④ 模板流（题材节拍模板）→ 我的项目（原工作区保留）。
   「一句话成片/模板跟拍」一站式直跑：POST /api/quickstart 自动建项目+建集+派 LLM 剧本生成。
   原「新建项目/新建集」表单整体收进「导演台」弹层（原逻辑不变）。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  /* state 里的 projects 是 map、episodes 实测是数组（契约允许两种）——统一成数组 */
  function toList(x) {
    if (Array.isArray(x)) return x.filter(v => v && typeof v === "object");
    if (x && typeof x === "object") {
      return Object.keys(x).map(k =>
        x[k] && typeof x[k] === "object" ? Object.assign({ id: k }, x[k]) : { id: k }
      );
    }
    return [];
  }

  /* 卡类型→拍板横幅文案（与 flow.js TYPE_META 口径一致，取用户视角名） */
  const CARD_CN = {
    C1: "故事方向", C2: "演员表", C2S: "试妆试镜", C3: "美术方案", C4: "分镜画面",
    C5: "样片节奏", C6: "开机报价", C7: "灰区批复", C8: "验收导出", C9: "配乐候选"
  };
  const STAGE_CN = {
    1: "方向策划", 2: "选角定妆", 3: "美术锁定", 4: "分镜画面",
    5: "样片节奏", 6: "预算开机", 7: "拍摄复审", 8: "交付完成"
  };

  const ProjectEmpty = {
    components: { "empty-state": T.components.EmptyState },
    template: `
      <div class="panel">
        <empty-state icon="🎬" text="还没有项目"
          sub="在上方说一句话、或挑个模板，直接开拍。"></empty-state>
      </div>`
  };

  views.Home = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "project-empty": ProjectEmpty
    },
    setup() {
      const state = Vue.computed(() => store.state);
      const err = Vue.computed(() => store.err.state);
      const bootLoading = Vue.computed(() => store.loading.state && !store.state);
      const projects = Vue.computed(() => toList(state.value && state.value.projects));
      const episodes = Vue.computed(() => toList(state.value && state.value.episodes));

      function epsOf(pid) {
        return episodes.value.filter(e => String(e.projectId) === String(pid));
      }
      function retry() { store.refreshState().catch(() => {}); }

      function costPct(e) {
        const b = Number(e && e.budget_cents);
        const c = Number(e && e.cost_cents) || 0;
        if (!Number.isFinite(b) || b <= 0) return 0;
        return Math.min(100, Math.round((c / b) * 100));
      }
      function costOver(e) {
        const b = Number(e && e.budget_cents);
        return Number.isFinite(b) && b > 0 && Number(e.cost_cents) > b;
      }
      function epTone(e) {
        if (!e) return "dim";
        if (e.paused) return "err";
        const st = Number(e.stage) || 0;
        if (st >= 6) return "ok";
        if (st >= 4) return "warn";
        if (st >= 2) return "run";
        return "dim";
      }
      function epHref(tab, id) {
        return "#/ep/" + encodeURIComponent(id) + "/" + tab;
      }
      function stageName(e) {
        return STAGE_CN[Number(e && e.stage) || 1] || "进行中";
      }

      /* ---------- S2 态③：拍板横幅（pending 卡按集归组，最早一张作横幅） ---------- */
      const pendingByEp = Vue.computed(() => {
        const cp = (state.value && state.value.cards_pending) || [];
        const m = {};
        (Array.isArray(cp) ? cp : Object.values(cp || {})).forEach(c => {
          if (c && c.status === "pending" && c.episodeId) {
            (m[c.episodeId] = m[c.episodeId] || []).push(c);
          }
        });
        return m;
      });
      const banners = Vue.computed(() => {
        return episodes.value
          .filter(e => !e.paused && pendingByEp.value[e.id] && pendingByEp.value[e.id].length)
          .map(e => {
            const cards = pendingByEp.value[e.id];
            const c = cards[0];
            return {
              epId: e.id, epTitle: e.title,
              label: CARD_CN[c.type] || "创作卡",
              more: cards.length > 1 ? cards.length - 1 : 0
            };
          });
      });

      /* ---------- S2 态②：继续创作（活动集，待拍板的排前） ---------- */
      const activeEps = Vue.computed(() => {
        const pend = pendingByEp.value;
        return episodes.value
          .filter(e => !e.paused && Number(e.stage || 1) < 8)
          .sort((a, b) =>
            (pend[b.id] ? 1 : 0) - (pend[a.id] ? 1 : 0) ||
            (Number(b.stage) || 0) - (Number(a.stage) || 0)
          );
      });

      /* ---------- 吸顶输入框（一句话成片 / 小说改编） ---------- */
      const hero = Vue.reactive({ mode: "one_liner", text: "", projectId: "" });
      const heroInput = Vue.ref(null);
      const busyStart = Vue.ref(false);
      async function startFromHero() {
        if (busyStart.value) return;
        const brief = String(hero.text || "").trim();
        if (!brief) { store.toast("先说一句：想拍什么？", "warn"); return; }
        busyStart.value = true;
        try {
          const r = await store.quickstart({
            brief: brief,
            mode: hero.mode,
            projectId: hero.projectId || undefined
          });
          hero.text = "";
          const ep = r && r.episode;
          if (ep && ep.id) global.__ROUTER.go("#/ep/" + encodeURIComponent(ep.id) + "/flow");
        } catch (e) { /* store 已 toast */ }
        finally { busyStart.value = false; }
      }
      function focusHero(mode) {
        hero.mode = mode;
        Vue.nextTick(() => {
          try { global.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
          if (heroInput.value && heroInput.value.focus) heroInput.value.focus();
        });
      }

      /* ---------- 四入口磁贴 ---------- */
      function goTemplates() {
        const el = document.getElementById("v-home-templates");
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
        else store.toast("模板流加载中，稍等一下", "warn");
      }
      const dirSheet = Vue.ref(false);

      /* ---------- 模板流 ---------- */
      const templates = Vue.computed(() => store.templates.list || []);
      Vue.onMounted(() => { store.loadTemplates().catch(() => {}); });
      const tplSheet = Vue.ref(null);
      const tplForm = Vue.reactive({ brief: "", projectId: "" });
      const busyTpl = Vue.ref(false);
      function useTemplate(t) {
        tplSheet.value = t;
        tplForm.brief = (t && t.brief_skeleton) || "";
        tplForm.projectId = "";
      }
      async function startFromTemplate() {
        if (busyTpl.value || !tplSheet.value) return;
        const brief = String(tplForm.brief || "").trim();
        if (!brief) { store.toast("填一句卖点或故事，才好开拍", "warn"); return; }
        busyTpl.value = true;
        try {
          const r = await store.quickstart({
            brief: brief,
            templateId: tplSheet.value.id,
            projectId: tplForm.projectId || undefined
          });
          tplSheet.value = null;
          const ep = r && r.episode;
          if (ep && ep.id) global.__ROUTER.go("#/ep/" + encodeURIComponent(ep.id) + "/flow");
        } catch (e) { /* store 已 toast */ }
        finally { busyTpl.value = false; }
      }

      /* ---------- 导演台（原「新建集/新建项目」表单，逻辑原样保留） ---------- */
      const form = Vue.reactive({ projectId: "", title: "", brief: "" });
      const busy = Vue.ref(false);
      const formErr = Vue.ref(null);
      Vue.watch(projects, ps => {
        if (!form.projectId && ps.length) form.projectId = String(ps[0].id);
      }, { immediate: true });

      async function submit() {
        if (busy.value) return;
        if (!form.projectId) { store.toast("先选一个项目", "warn"); return; }
        if (!String(form.title || "").trim()) { store.toast("给集起个标题", "warn"); return; }
        if (!String(form.brief || "").trim()) { store.toast("写一句话故事（必填）", "warn"); return; }
        busy.value = true;
        formErr.value = null;
        try {
          const ep = await store.createEpisode({
            projectId: form.projectId,
            title: String(form.title).trim(),
            brief: String(form.brief).trim()
          });
          dirSheet.value = false;
          const id = ep && ep.id;
          if (id) global.__ROUTER.go("#/ep/" + encodeURIComponent(id) + "/flow");
        } catch (e) {
          formErr.value = e;
        } finally {
          busy.value = false;
        }
      }

      const formP = Vue.reactive({ title: "", look: "写实电影感" });
      const busyP = Vue.ref(false);
      const formErrP = Vue.ref(null);
      async function submitProject() {
        if (busyP.value) return;
        if (!String(formP.title || "").trim()) { store.toast("给项目起个名字", "warn"); return; }
        busyP.value = true;
        formErrP.value = null;
        try {
          const pj = await store.createProject({
            title: String(formP.title).trim(),
            style_pkg: { look: formP.look, palette: "青橙", ratio: "9:16" }
          });
          formP.title = "";
          const id = pj && pj.id;
          if (id) form.projectId = String(id); // 新项目直接进「新建集」的默认选中
        } catch (e) {
          formErrP.value = e;
        } finally {
          busyP.value = false;
        }
      }

      /* ---------- 删除（二次确认在 store 层；2026-11-22） ---------- */
      async function delEpisode(e) {
        if (!e || !e.id) return;
        try { await store.deleteEpisode(e.id); } catch (err) { /* store 已 toast */ }
      }
      async function delProject(p) {
        if (!p || !p.id) return;
        const n = epsOf(p.id).length;
        if (n) { store.toast("项目下还有 " + n + " 集，先删集再删项目", "warn"); return; }
        try { await store.deleteProject(p.id); } catch (err) { /* store 已 toast */ }
      }

      return {
        store, state, err, bootLoading, projects, episodes,
        epsOf, retry, costPct, costOver, epTone, epHref, stageName,
        banners, activeEps,
        hero, heroInput, busyStart, startFromHero, focusHero,
        goTemplates, dirSheet,
        templates, tplSheet, tplForm, busyTpl, useTemplate, startFromTemplate,
        form, busy, formErr, submit,
        formP, busyP, formErrP, submitProject,
        delEpisode, delProject
      };
    },
    template: `
      <div class="v-home">

        <loading v-if="bootLoading && !err"></loading>
        <div class="panel" v-else-if="err">
          <err-state :err="err" :on-retry="retry"></err-state>
        </div>

        <template v-else-if="state">

          <!-- 态③ 拍板横幅：90 秒回访钩子 -->
          <a class="v-home-banner" v-for="b in banners" :key="'b'+b.epId" :href="epHref('flow', b.epId)">
            <span class="v-home-banner-in">📌 {{ b.label }}等你拍板 · {{ b.epTitle }}
              <span class="weak" v-if="b.more">（还有 {{ b.more }} 张）</span></span>
            <span class="v-home-banner-go">去拍板 →</span>
          </a>

          <!-- 态② 继续创作 -->
          <div class="v-home-continue" v-if="activeEps.length">
            <div class="card v-home-ct" v-for="e in activeEps.slice(0, 4)" :key="e.id">
              <div class="row spread">
                <b class="v-home-ct-t">{{ e.title }}</b>
                <span class="badge v-home-stage" :class="epTone(e)">{{ stageName(e) }}</span>
              </div>
              <div class="v-home-cost">
                <money :cents="e.cost_cents"></money>
                <span class="weak">/ 预算</span>
                <money :cents="e.budget_cents"></money>
                <div class="progress" :class="{ over: costOver(e) }">
                  <div class="bar"><span :style="{ width: costPct(e) + '%' }"></span></div>
                </div>
              </div>
              <a class="btn btn-primary btn-sm v-home-ct-go" :href="epHref('flow', e.id)">继续 ▶</a>
            </div>
          </div>

          <!-- 态① 吸顶输入框：一句话/小说 -->
          <div class="card v-home-hero">
            <div class="v-home-hero-tabs" role="tablist">
              <button type="button" class="v-home-hero-tab" :class="{ sel: hero.mode === 'one_liner' }"
                @click="focusHero('one_liner')">⚡ 一句话成片</button>
              <button type="button" class="v-home-hero-tab" :class="{ sel: hero.mode === 'novel' }"
                @click="focusHero('novel')">📖 小说改编</button>
            </div>
            <textarea ref="heroInput" class="v-home-hero-input" rows="3" v-model="hero.text"
              :placeholder="hero.mode === 'novel'
                ? '贴章节、整篇小说都行——提炼改编成一集…'
                : '一句话、一段故事，都行——例：外卖员觉醒系统，送单送成全城传说'"
              @keydown.ctrl.enter="startFromHero" @keydown.meta.enter="startFromHero"></textarea>
            <div class="v-home-hero-acts">
              <select class="select v-home-hero-pj" v-model="hero.projectId" :aria-label="'归属项目'">
                <option value="">✨ 自动新建项目</option>
                <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.title }}</option>
              </select>
              <button class="btn btn-primary v-home-hero-go" @click="startFromHero"
                :disabled="busyStart" :aria-busy="busyStart">
                {{ busyStart ? '开机中…' : '开拍 ▶' }}
              </button>
            </div>
            <div class="weak v-home-hero-note">
              说一句就全流程自动跑：剧本 → 定妆 → 分镜 → 样片 → 开机；整段长文会按小说改编提炼成一集。
            </div>
          </div>

          <!-- 四入口磁贴 -->
          <div class="v-home-tiles">
            <button type="button" class="v-home-tile" @click="focusHero('one_liner')">
              <i>⚡</i><b>一句话成片</b><span>说一句，全流程自动跑</span>
            </button>
            <button type="button" class="v-home-tile" @click="focusHero('novel')">
              <i>📖</i><b>小说改编</b><span>贴长文，提炼改编一集</span>
            </button>
            <button type="button" class="v-home-tile" @click="goTemplates">
              <i>🧩</i><b>模板跟拍</b><span>选节拍模板，填卖点开拍</span>
            </button>
            <button type="button" class="v-home-tile" @click="dirSheet = true">
              <i>🎛</i><b>导演台</b><span>全流程手动控制</span>
            </button>
            <div class="v-home-tile dim" title="二期开放">
              <i>📁</i><b>导入分镜表</b><span>二期开放</span>
            </div>
          </div>

          <!-- 模板流 -->
          <div id="v-home-templates" class="panel v-home-tpl-sec">
            <div class="panel-title">🧩 模板流 <span class="weak">题材节拍模板 · 选一个直接开拍</span></div>
            <div class="v-home-tpl-rail" v-if="templates.length">
              <div class="card v-home-tpl" v-for="t in templates" :key="t.id">
                <div class="v-home-tpl-demo">
                  <video v-if="t.demo && t.demo.url" :src="t.demo.url" muted autoplay loop
                    playsinline></video>
                  <span v-else class="v-home-tpl-ph"><i>▶</i></span>
                  <span class="v-home-tpl-mark">demo · 成片 {{ t.demo && t.demo.dur_sec ? t.demo.dur_sec : 45 }}s</span>
                </div>
                <div class="row spread">
                  <b>{{ t.name }}</b>
                  <span class="badge">{{ t.genre }}</span>
                </div>
                <div class="weak">{{ t.desc }}</div>
                <button type="button" class="btn btn-ghost v-home-tpl-use" @click="useTemplate(t)">用这个模板</button>
              </div>
            </div>
            <div class="weak" v-else-if="store.templates.loading">模板加载中…</div>
            <div class="weak" v-else>还没有可用模板（运营在运维台配置）。</div>
          </div>

          <!-- 我的项目（原工作区列表保留） -->
          <empty-state v-if="!projects.length" icon="📁" text="还没有项目"
            sub="在上方说一句话、或挑个模板，直接开拍。"></empty-state>

          <div class="panel" v-for="p in projects" :key="p.id">
            <div class="v-home-proj">
              <span class="card-title">{{ p.title }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.look">{{ p.style_pkg.look }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.palette">配色 {{ p.style_pkg.palette }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.ratio">{{ p.style_pkg.ratio }}</span>
              <span class="grow"></span>
              <button type="button" class="btn btn-sm btn-danger"
                @click="delProject(p)">删除项目</button>
            </div>

            <div class="list" v-if="epsOf(p.id).length">
              <div class="list-item v-home-ep" v-for="e in epsOf(p.id)" :key="e.id">
                <div class="row wrap">
                  <span class="v-home-epdot" :class="epTone(e)"></span>
                  <b>{{ e.title }}</b>
                  <span class="badge v-home-stage" :class="epTone(e)">阶段 {{ e.stage == null ? '—' : e.stage }}</span>
                  <span class="badge badge-warn" v-if="e.paused">已暂停</span>
                  <span class="weak">人工决策 <b class="num">{{ e.decisions || 0 }}</b>/5</span>
                  <span class="grow"></span>
                  <a class="btn btn-primary btn-sm" :href="epHref('flow', e.id)">进工作台</a>
                  <a class="btn btn-sm" :href="epHref('shoot', e.id)">拍摄</a>
                  <button type="button" class="btn btn-sm btn-danger"
                    @click="delEpisode(e)">删除</button>
                </div>
                <div class="v-home-cost">
                  <money :cents="e.cost_cents"></money>
                  <span class="weak">/ 预算</span>
                  <money :cents="e.budget_cents"></money>
                  <div class="progress" :class="{ over: costOver(e) }">
                    <div class="bar"><span :style="{ width: costPct(e) + '%' }"></span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="weak" v-else>这个项目还没有集，点上方「开拍」或进导演台开一集。</div>
          </div>

          <!-- 导演台弹层（原新建项目/新建集表单） -->
          <div class="overlay" v-if="dirSheet" @click.self="dirSheet = false">
            <div class="sheet card v-home-dir">
              <div class="sheet-title">🎛 导演台 <span class="weak">全流程手动控制</span></div>

              <div class="panel-title">📁 新建项目 <span class="weak">短剧项目容器</span></div>
              <form class="v-home-form" @submit.prevent="submitProject">
                <label class="field">
                  <span class="field-label">项目名称</span>
                  <input class="input" v-model.trim="formP.title" placeholder="例：古风甜宠频道 / 都市逆袭系列" />
                </label>
                <label class="field">
                  <span class="field-label">画面影调</span>
                  <select class="select" v-model="formP.look">
                    <option>写实电影感</option>
                    <option>柔光唯美</option>
                    <option>冷冽悬疑</option>
                  </select>
                </label>
                <div class="v-home-acts">
                  <button class="btn" type="submit" :disabled="busyP" :aria-busy="busyP">
                    {{ busyP ? '创建中…' : '创建项目' }}
                  </button>
                  <loading v-if="busyP"></loading>
                  <err-state v-if="formErrP" :err="formErrP" :on-retry="submitProject" compact></err-state>
                </div>
              </form>

              <hr class="sep" />

              <div class="panel-title">🎬 新建集 <span class="weak">建完直接进卡流</span></div>
              <form class="v-home-form" @submit.prevent="submit">
                <label class="field">
                  <span class="field-label">项目</span>
                  <select class="select" v-model="form.projectId">
                    <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.title }}</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">集标题</span>
                  <input class="input" v-model.trim="form.title" placeholder="例：第 2 集 · 灯塔之约" />
                </label>
                <label class="field v-home-brief">
                  <span class="field-label">一句话故事（必填）</span>
                  <textarea class="textarea" rows="3" v-model.trim="form.brief"
                    placeholder="例：雨夜，她在灯塔下和十年前出走的母亲和解。"></textarea>
                </label>
                <div class="v-home-acts">
                  <button class="btn btn-primary" type="submit" :disabled="busy" :aria-busy="busy">
                    {{ busy ? '创建中…' : '创建并进卡流' }}
                  </button>
                  <loading v-if="busy"></loading>
                  <err-state v-if="formErr" :err="formErr" :on-retry="submit" compact></err-state>
                </div>
              </form>

              <div class="sheet-acts">
                <button type="button" class="btn btn-ghost" @click="dirSheet = false">收起</button>
              </div>
            </div>
          </div>

          <!-- 模板开拍弹层 -->
          <div class="overlay" v-if="tplSheet" @click.self="tplSheet = null">
            <div class="sheet card v-home-tplsheet">
              <div class="sheet-title">🧩 {{ tplSheet.name }}
                <span class="badge">{{ tplSheet.genre }}</span></div>
              <div class="weak" v-if="tplSheet.desc">{{ tplSheet.desc }}</div>
              <div class="v-home-tpl-beats" v-if="tplSheet.beats && tplSheet.beats.length">
                <div class="v-home-tpl-beat" v-for="(bp, i) in tplSheet.beats" :key="i">
                  <b>{{ i + 1 }}. {{ bp.beat }}</b>
                  <span class="weak">{{ bp.guide }}</span>
                </div>
              </div>
              <label class="field">
                <span class="field-label">归属项目</span>
                <select class="select" v-model="tplForm.projectId">
                  <option value="">✨ 自动新建项目（沿用模板影调）</option>
                  <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.title }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">卖点 / 一句话故事</span>
                <textarea class="textarea" rows="3" v-model.trim="tplForm.brief"
                  placeholder="按模板填卖点或一句话故事…"></textarea>
              </label>
              <div class="sheet-acts">
                <button type="button" class="btn btn-primary" @click="startFromTemplate"
                  :disabled="busyTpl" :aria-busy="busyTpl">
                  {{ busyTpl ? '开机中…' : '用这个模板开拍 ▶' }}
                </button>
                <button type="button" class="btn btn-ghost" @click="tplSheet = null">先不了</button>
              </div>
            </div>
          </div>

        </template>
      </div>`
  };
})(window);
