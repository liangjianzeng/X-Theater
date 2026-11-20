/* 剧场 Studio · 资产/音乐视图（视图 C 负责）
   #/ep/:id/assets：曲库表（标题/心情/时长/许可/影子成本/挂接场）＋挂到本场＋生成候选。
   数据来自 store.loadMusic()（GET /api/music/library）与 store.state.scenes_by_episode。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const MOODS = ["释然", "离别", "压抑", "对峙", "其它"];

  views.Assets = {
    props: { epId: { type: String, required: true } },
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "license-badge": T.components.LicenseBadge
    },
    setup(props) {
      const music = Vue.computed(() => store.music);
      const library = Vue.computed(() => store.music.library || []);
      const loading = Vue.computed(() => store.music.loading && store.music.library == null);
      const err = Vue.computed(() => store.music.error);

      /* 本集场景（挂接候选） */
      const scenes = Vue.computed(() => {
        const s = store.state;
        return (s && s.scenes_by_episode && s.scenes_by_episode[props.epId]) || [];
      });
      /* 全局场景索引：id → {name, episodeId}（显示曲库行「挂接场」用） */
      const sceneMap = Vue.computed(() => {
        const out = {};
        const s = store.state;
        if (s && s.scenes_by_episode) {
          Object.keys(s.scenes_by_episode).forEach(k => {
            (s.scenes_by_episode[k] || []).forEach(sc => { out[sc.id] = sc; });
          });
        }
        return out;
      });
      function sceneLabel(scid) {
        if (!scid) return "未挂接";
        const sc = sceneMap.value[scid];
        return sc ? sc.name : String(scid);
      }

      function loadMusic() { return store.loadMusic().catch(() => {}); }
      function retryState() { store.refreshState().catch(() => {}); }

      /* ---------- 挂到本场 ---------- */
      const pick = Vue.reactive({});
      const adopting = Vue.ref("");
      async function adopt(m) {
        const sid = pick[m.id];
        if (!sid || adopting.value) return;
        adopting.value = String(m.id);
        try {
          await store.adoptMusic(m.id, sid);
          pick[m.id] = "";
        } catch (e) { /* store 已 toast */ }
        finally { adopting.value = ""; }
      }

      /* ---------- 生成候选 ---------- */
      const genScene = Vue.ref("");
      const genMood = Vue.ref("释然");
      const moodOther = Vue.ref("");
      const genBusy = Vue.ref(false);
      let refreshTimer = null;
      Vue.watch(scenes, list => {
        if (!genScene.value && list.length) genScene.value = String(list[0].id);
      }, { immediate: true });
      const effectiveMood = Vue.computed(() => {
        if (genMood.value === "其它") return String(moodOther.value || "").trim();
        return genMood.value;
      });
      const canGen = Vue.computed(() => !!genScene.value && !!effectiveMood.value && !genBusy.value);

      async function gen() {
        if (!canGen.value) return;
        genBusy.value = true;
        try {
          const r = await store.genCandidates(genScene.value, effectiveMood.value);
          if (r) {
            /* 候选由队列异步落库：3 秒后重取曲库 */
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => loadMusic(), 3000);
          }
        } catch (e) { /* store 已 toast */ }
        finally { genBusy.value = false; }
      }

      Vue.onMounted(() => {
        loadMusic();
        if (!store.state) store.refreshState().catch(() => {});
      });
      Vue.onUnmounted(() => clearTimeout(refreshTimer));

      return {
        music, library, loading, err, scenes, sceneLabel,
        loadMusic, retryState, pick, adopting, adopt,
        genScene, genMood, moodOther, MOODS, genBusy, canGen, gen
      };
    },
    template: `
      <div class="v-assets">
        <div class="panel">
          <div class="panel-title">曲库 </div>
          <loading v-if="loading && !err"></loading>
          <err-state v-else-if="err" :err="err" :on-retry="loadMusic"></err-state>
          <empty-state v-else-if="!library.length" icon="🎵" text="曲库还是空的"
            sub="用下方「生成候选」给某场先来三段，出来后在这里挑。"></empty-state>
          <div class="table-scroll" v-else>
          <table class="table v-assets-tools">
            <thead>
              <tr>
                <th>曲目</th><th>心情</th><th>时长</th><th>许可</th>
                <th>成本</th><th>挂接场</th><th>挂到本场</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in library" :key="m.id">
                <td><b>{{ m.title }}</b></td>
                <td><span class="badge">{{ m.mood }}</span></td>
                <td class="num">{{ m.sec == null ? '—' : m.sec }} 秒</td>
                <td><license-badge :license="m.license"></license-badge></td>
                <td><money :cents="m.shadow_cents"></money></td>
                <td class="weak">{{ sceneLabel(m.sceneId) }}</td>
                <td>
                  <div class="row v-assets-adopt">
                    <select class="select v-assets-sel" v-model="pick[m.id]">
                      <option value="">选本场…</option>
                      <option v-for="sc in scenes" :key="sc.id" :value="String(sc.id)">{{ sc.name }}</option>
                    </select>
                    <button class="btn btn-sm" :disabled="!pick[m.id] || adopting === String(m.id)"
                      @click="adopt(m)">挂到本场</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">生成候选 <span class="weak">一次出 3 段，进待选</span></div>
          <div class="v-assets-gen">
            <label class="field">
              <span class="field-label">场次</span>
              <select class="select" v-model="genScene" :disabled="!scenes.length">
                <option value="" v-if="!scenes.length">本集还没有场次</option>
                <option v-for="sc in scenes" :key="sc.id" :value="String(sc.id)">{{ sc.name }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">心情</span>
              <select class="select" v-model="genMood">
                <option v-for="md in MOODS" :key="md" :value="md">{{ md === '其它' ? '其它（自填）' : md }}</option>
              </select>
            </label>
            <div class="v-assets-acts">
              <button class="btn btn-primary" :disabled="!canGen" :aria-busy="genBusy" @click="gen">
                {{ genBusy ? '排队中…' : '生成候选' }}
              </button>
              <loading v-if="genBusy"></loading>
            </div>
            <label class="field" v-if="genMood === '其它'" style="grid-column: 1 / 3;">
              <span class="field-label">自填心情</span>
              <input class="input" v-model.trim="moodOther" maxlength="12" placeholder="例：暗涌" />
            </label>
          </div>
          <div class="weak" v-if="!scenes.length" style="margin-top:8px;">
            本集还没有场次：先去「创作卡流」把分场卡走完，再回来配配乐。
          </div>
        </div>
      </div>`
  };
})(window);
