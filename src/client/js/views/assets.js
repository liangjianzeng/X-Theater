/* 剧场 Studio · 集侧素材挂接视图（2026-11-22 素材中心施工 A7）
   #/ep/:id/assets：本集「开拍就绪」清单＋每场主曲绑定器。
   职责变化（裁决 K1/K6）：本视图不再生成素材——生成在一级「素材中心」（#/studio）；
   这里只做消费：把库里的曲绑定到本集场景（1:N + 主曲），缺素材直达素材中心补。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  views.Assets = {
    props: { epId: { type: String, required: true } },
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "license-badge": T.components.LicenseBadge
    },
    setup(props) {
      const lib = Vue.computed(() => store.studio.lib.music || []);
      const scenes = Vue.computed(() => {
        const s = store.state;
        return (s && s.scenes_by_episode && s.scenes_by_episode[props.epId]) || [];
      });
      const readiness = Vue.computed(() => store.studio.readiness);
      const loading = Vue.ref(true);
      const err = Vue.ref(null);

      /* 每场当前绑定：primary 主曲 + 其它绑定 */
      function bindingsOf(sceneId) {
        const sid = String(sceneId);
        const bound = lib.value.filter(m => (m.used_by || []).some(u => u.kind === "scene" && String(u.id) === sid) && m.status !== "retired");
        const primary = bound.filter(m => (m.used_by || []).some(u => u.kind === "scene" && String(u.id) === sid && u.primary));
        return { primary: primary[0] || null, others: bound.filter(m => !primary.includes(m)) };
      }
      /* 旧 music_lib 语义兼容显示（迁移前旧数据 sceneId 直挂） */
      function legacyOf(sceneId) {
        const sid = String(sceneId);
        return lib.value.filter(m => m.sceneId && String(m.sceneId) === sid && !(m.used_by || []).length && m.status !== "retired");
      }

      const pick = Vue.reactive({});
      const busy = Vue.ref("");
      async function bindPrimaryMusic(sc) {
        const id = pick[sc.id];
        if (!id || busy.value) return;
        busy.value = sc.id;
        try {
          await store.studioBind("music", id, "scene", sc.id, true);
          pick[sc.id] = "";
        } catch (e) { /* toast 已发 */ }
        finally { busy.value = ""; }
      }
      async function unbind(m, sc) {
        busy.value = sc.id;
        try { await store.studioUnbind("music", m.id, "scene", sc.id); }
        finally { busy.value = ""; }
      }

      async function refresh() {
        loading.value = true;
        err.value = null;
        try {
          if (!store.state) await store.refreshState();
          await store.loadStudioDomain("music");
          await store.studioReadiness(props.epId);
        } catch (e) { err.value = e; }
        finally { loading.value = false; }
      }
      Vue.onMounted(refresh);
      Vue.watch(() => props.epId, refresh);

      const missing = Vue.computed(() => {
        const r = readiness.value;
        if (!r) return [];
        const out = [];
        if (!r.theme) out.push({ label: "还没选主题曲", tab: "music" });
        (r.items || []).forEach(i => {
          if (i.kind === "scene") {
            if (!i.hasMusic) out.push({ label: "场景「" + i.name + "」没有配乐", tab: "music" });
            if (!i.hasCard) out.push({ label: "场景「" + i.name + "」没有场景卡/定场图", tab: "scenes" });
          } else {
            if (!i.hasCharacter) out.push({ label: "角色「" + i.name + "」未入角色库", tab: "characters" });
            if (i.hasCharacter && !i.hasCast) out.push({ label: "角色「" + i.name + "」缺定妆图", tab: "characters" });
          }
        });
        return out;
      });

      return {
        lib, scenes, readiness, loading, err, refresh,
        bindingsOf, legacyOf, pick, busy, bindPrimaryMusic, unbind, missing,
        artUrl: T.artUrl
      };
    },
    template: `
      <div class="v-assets">
        <div class="panel">
          <div class="panel-title">开拍就绪 <span class="weak">素材先铺满，再进拍摄——缺什么去
            <a href="#/studio">素材中心</a> 补</span>
            <span class="badge" :class="readiness && readiness.ready ? 'badge-ok' : ''"
              v-if="readiness">{{ readiness.ready ? '✓ 就绪' : '缺素材' }}</span>
          </div>
          <loading v-if="loading && !err"></loading>
          <err-state v-else-if="err" :err="err" :on-retry="refresh"></err-state>
          <template v-else>
            <div class="kv num" v-if="missing.length">
              <div v-for="(m,i) in missing" :key="i">⚠ {{ m.label }}　<a :href="'#/studio/'+m.tab">去补 →</a></div>
            </div>
            <empty-state v-else-if="readiness" icon="✅" text="素材就绪"
              sub="本集场景都有配乐与场景卡，角色都已入库。"></empty-state>
          </template>
        </div>

        <div class="panel">
          <div class="panel-title">本集场景 × 配乐绑定 <span class="weak">每场一首主曲；同一首曲可挂多场（互不影响）</span></div>
          <loading v-if="loading && !err"></loading>
          <err-state v-else-if="err" :err="err" :on-retry="refresh"></err-state>
          <empty-state v-else-if="!scenes.length" icon="🎬" text="本集还没有场次"
            sub="先去「创作卡流」把分场卡走完，再回来挂配乐。"></empty-state>
          <div class="table-scroll" v-else>
            <table class="table">
              <thead><tr><th>场次</th><th>氛围</th><th>主曲</th><th>备选（其它绑定）</th><th>换主曲</th></tr></thead>
              <tbody>
                <tr v-for="sc in scenes" :key="sc.id">
                  <td><b>{{ sc.name }}</b></td>
                  <td><span class="badge">{{ sc.mood }}</span></td>
                  <td>
                    <template v-if="bindingsOf(sc.id).primary">
                      <b>{{ bindingsOf(sc.id).primary.title }}</b>
                      <audio v-if="bindingsOf(sc.id).primary.art" controls preload="none"
                        :src="artUrl(bindingsOf(sc.id).primary.art)" style="max-width:150px;height:26px"></audio>
                      <button class="btn btn-sm btn-ghost" :disabled="busy===sc.id" @click="unbind(bindingsOf(sc.id).primary, sc)">解绑</button>
                    </template>
                    <template v-else-if="legacyOf(sc.id).length">
                      <b>{{ legacyOf(sc.id)[0].title }}</b> <span class="weak">（旧挂接）</span>
                    </template>
                    <span v-else class="weak">未挂接</span>
                  </td>
                  <td class="weak">
                    <span v-for="(m,i) in bindingsOf(sc.id).others" :key="m.id">{{ m.title }}{{ i < bindingsOf(sc.id).others.length-1 ? '、' : '' }}</span>
                    <span v-if="!bindingsOf(sc.id).others.length">—</span>
                  </td>
                  <td>
                    <div class="row v-assets-adopt">
                      <select class="select v-assets-sel" v-model="pick[sc.id]">
                        <option value="">从曲库选…</option>
                        <option v-for="m in lib" :key="m.id" :value="m.id">{{ m.title }}（{{ m.mood }}）</option>
                      </select>
                      <button class="btn btn-sm" :disabled="!pick[sc.id] || busy===sc.id" @click="bindPrimaryMusic(sc)">设为主曲</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="weak" v-if="scenes.length && !(lib.length)" style="margin-top:8px;">
            曲库还是空的：去 <a href="#/studio/music">素材中心 · 音频</a> 生成或上传，再回来绑定。
          </div>
        </div>
      </div>`
  };
})(window);
