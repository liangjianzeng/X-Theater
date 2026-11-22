/* 剧场 Studio · 素材中心视图（2026-11-22 素材中心施工 A6/B7）
   #/studio 与 #/studio/<tab>：音频 / 图像 / 角色 / 场景 / 设定 / 候选池。
   工作流（行业主流）：生成→候选池筛选→收藏入库→绑定消费；与集工作台解耦（裁决 K1）。
   数据面：store.studio（api/library.js → st.asset_lib / st.asset_drafts）。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const MUSIC_TYPES = [
    { v: "bgm", label: "背景 BGM" },
    { v: "theme", label: "主题曲" },
    { v: "ambient", label: "氛围垫乐" },
    { v: "mv", label: "MV 成曲" }
  ];
  /* 专业配置常量（与服务端 prompts/dicts.js MUSIC_* 镜像；组装以服务端为准） */
  const MUSIC_MODES = [
    { v: "quick", label: "快速", hint: "心情一键，词典+风格包兜底" },
    { v: "standard", label: "标准", hint: "曲风/乐器/人声/BPM 结构化配置" },
    { v: "expert", label: "专家", hint: "自由 tags＋完整歌词（结构标记）＋自然语言描述" }
  ];
  const MUSIC_GENRES = [
    "pop", "ballad", "rock", "electronic", "synthwave", "orchestral", "solo piano", "strings",
    "lo-fi", "jazz", "r&b", "hip-hop", "folk", "chinese traditional", "ambient", "cinematic",
    "city pop", "blues"
  ];
  const MUSIC_INSTRUMENTS = [
    "piano", "acoustic guitar", "electric guitar", "strings ensemble", "brass", "flute",
    "dizi", "guzheng", "erhu", "synth pad", "drums", "bass", "guitar solo", "violin solo", "hand percussion"
  ];
  const MUSIC_VOCALS = [
    { v: "", label: "纯音乐" }, { v: "female vocal", label: "女声" }, { v: "male vocal", label: "男声" },
    { v: "duet female male vocal", label: "男女对唱" }, { v: "choir", label: "合唱" }, { v: "whisper vocal", label: "气声吟唱" }
  ];
  const MUSIC_TYPE_PRESETS = {
    bgm: { instrumental: true, structureLine: "[intro] [gentle build] [sustain] [soft fade]", lyrics: "", hint: "垫乐质感：不抢台词，纯音乐默认" },
    theme: { instrumental: false, structureLine: "[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Chorus] [Bridge] [Final Chorus] [Outro]", lyrics: "[Intro]\n[Verse 1]\n（主歌第一段：起于场景与人物）\n\n[Pre-Chorus]\n（情绪推进）\n\n[Chorus]\n（副歌记忆点）\n\n[Verse 2]\n\n[Chorus]\n\n[Bridge]\n（转折/留白）\n\n[Final Chorus]\n\n[Outro]", hint: "完整歌曲结构，副歌记忆点" },
    ambient: { instrumental: true, structureLine: "[ambient drone] [texture layers] [slow evolution] [fade]", lyrics: "", hint: "氛围床：循环无痕，纯音乐默认" },
    mv: { instrumental: false, structureLine: "[Intro] [Verse] [Pre-Chorus] [Chorus] [Post-Chorus] [Verse] [Chorus] [Outro]", lyrics: "[Intro]\n[Verse]\n（叙事段）\n\n[Pre-Chorus]\n\n[Chorus]\n（强记忆点）\n\n[Post-Chorus]\n（hook 重复）\n\n[Chorus]\n\n[Outro]", hint: "节奏明快，hook 密集，适合卡点" }
  };
  const LYRIC_MARKS = ["[Intro]", "[Verse 1]", "[Verse 2]", "[Pre-Chorus]", "[Chorus]", "[Post-Chorus]", "[Bridge]", "[Final Chorus]", "[Outro]", "[Instrumental]", "[Guitar Solo]"];
  const IMAGE_TYPES = [
    { v: "establishing", label: "定场图", hint: "大景别交代环境，人物极小或无" },
    { v: "empty", label: "空镜/氛围", hint: "纯环境情绪，光影氛围优先" },
    { v: "prop", label: "道具", hint: "特写棚拍或场景内道具" },
    { v: "poster", label: "海报底图", hint: "主体突出，顶部留标题负空间" },
    { v: "mood", label: "氛围图", hint: "情绪浓度优先的画感图" },
    { v: "mv", label: "MV 素材", hint: "适合卡点剪辑的人物/场景图" }
  ];
  /* 图像专业配置镜像（服务端 prompts/dicts SHOT_SIZE 口径） */
  const IMAGE_SIZES = ["远景", "全景", "中景", "近景", "特写"];
  const IMAGE_LIGHTS = [
    { v: "冷蓝深夜，硬阴影", label: "夜雨冷蓝" }, { v: "暖金柔光，轻微逆光雾", label: "暖金柔光" },
    { v: "清晨侧逆光，薄雾", label: "清晨薄雾" }, { v: "正午顶光，高对比", label: "正午顶光" },
    { v: "烛光暖黄，明暗交界", label: "烛光" }, { v: "霓虹夜色，湿地面反光", label: "霓虹夜色" }
  ];
  const LOOKS = ["写实电影感", "柔光唯美", "冷冽悬疑", "夜色胶片"];
  const MOODS = ["释然", "离别", "压抑", "对峙", "温馨", "中性", "其它"];
  const SECS = [15, 30, 45, 60];
  const TABS = [
    { key: "music", label: "🎵 音频" },
    { key: "images", label: "🖼 图像" },
    { key: "characters", label: "👤 角色" },
    { key: "scenes", label: "🏞 场景" },
    { key: "canon", label: "🎭 设定" },
    { key: "drafts", label: "📥 候选池" }
  ];

  // 素材寻址统一走 T.artUrl（素材中心 2026-11-22 修复：裸文件名=cast 参考、var/=产物面）
  function srcOf(art) { return T.artUrl(art); }
  /* 灯箱预览（2026-11-22 用户裁决：图片要可以预览，否则没法判断） */
  const preview = Vue.ref(null);
  function openPreview(art, title) { preview.value = { art: srcOf(art), title: title || "" }; }
  function closePreview() { preview.value = null; }
  /* 音频诚实化：占位/坏文件加载失败 → 如实标注（不再让空文件冒充候选） */
      const audioFail = Vue.reactive({});
      global.addEventListener("keydown", function (e) { if (e.key === "Escape") preview.value = null; });
  function fmtSec(s) { return s == null ? "—" : s + " 秒"; }

  views.Studio = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "license-badge": T.components.LicenseBadge
    },
    setup() {
      const route = global.__ROUTER.current;
      const tab = Vue.ref((route && route.view === "Studio" && global.location.hash.split("/")[2]) || "music");
      if (!TABS.some(t => t.key === tab.value)) tab.value = "music";

      /* ---------- 轮询：候选池有生成任务在跑时 4s 刷新 ---------- */
      let pollTimer = null;
      let pollLeft = 0;
      function startPolling(seconds) {
        pollLeft = Math.max(pollLeft, seconds || 40);
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          pollLeft -= 4;
          store.loadStudioDrafts().catch(() => {});
          if (pollLeft <= 0) { clearInterval(pollTimer); pollTimer = null; }
        }, 4000);
      }
      function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

      const summary = Vue.computed(() => store.studio.summary);
      const drafts = Vue.computed(() => store.studio.drafts);
      const lib = Vue.computed(() => store.studio.lib);
      const projects = Vue.computed(() => {
        const s = store.state;
        return s ? Object.values(s.projects || {}) : [];
      });
      const episodes = Vue.computed(() => {
        const s = store.state;
        return s ? Object.values(s.episodes || {}) : [];
      });

      Vue.onMounted(() => {
        store.loadStudioSummary();
        store.loadStudioDrafts();
        ["music", "images", "characters", "scenes"].forEach(d => store.loadStudioDomain(d));
        if (!store.state) store.refreshState().catch(() => {});
      });
      Vue.onUnmounted(stopPolling);

      function goTab(k) {
        tab.value = k;
        global.location.hash = "#/studio/" + k;
        store.loadStudioDrafts().catch(() => {});
      }

      /* ================= 音频域（专业配置：三模式×类型预设，对齐 ACE-Step 通道） ================= */
      const gMusic = Vue.reactive({
        mode: "standard", type: "bgm", mood: "释然", moodOther: "",
        freeTags: "", genres: [], instruments: [], bpm: "", vocal: "", instrumental: true,
        structure: "", lyrics: "", caption: "",
        sec: 45, count: 1, projectId: "", _dirtyLyrics: false
      });
      const mBusy = Vue.ref(false);
      const mWarns = Vue.ref([]);
      const preset = Vue.computed(() => MUSIC_TYPE_PRESETS[gMusic.type] || { instrumental: true, structureLine: "", lyrics: "", hint: "" });
      function applyPreset(force) {
        gMusic.instrumental = !!preset.value.instrumental;
        gMusic.structure = preset.value.structureLine || "";
        if (force || !gMusic._dirtyLyrics) { gMusic.lyrics = preset.value.lyrics || ""; gMusic._dirtyLyrics = false; }
      }
      Vue.watch(() => gMusic.type, () => applyPreset(true));
      applyPreset(true);
      function toggleChip(arr, tag) {
        const i = arr.indexOf(tag);
        if (i >= 0) arr.splice(i, 1); else arr.push(tag);
      }
      function resetPreset() { gMusic._dirtyLyrics = false; applyPreset(true); }
      function markLyricsDirty() { gMusic._dirtyLyrics = true; }
      function insLyric(mark) {
        gMusic.lyrics = (gMusic.lyrics || "") + (gMusic.lyrics ? "\n\n" : "") + mark + "\n";
        gMusic._dirtyLyrics = true;
      }
      const effMood = Vue.computed(() => (gMusic.mood === "其它" ? String(gMusic.moodOther || "").trim() : gMusic.mood));
      async function genMusic() {
        if (mBusy.value) return;
        if (gMusic.mode === "quick" && !effMood.value) return;
        if (gMusic.mode !== "quick" && !gMusic.instrumental && !String(gMusic.lyrics || "").trim() && gMusic.type !== "bgm" && gMusic.type !== "ambient") {
          mWarns.value = ["要人声请先填歌词（或切回纯音乐）"]; return;
        }
        mBusy.value = true;
        mWarns.value = [];
        try {
          const spec = {
            mode: gMusic.mode, type: gMusic.type,
            mood: gMusic.mode === "quick" ? effMood.value : (effMood.value || undefined),
            sec: gMusic.sec, count: gMusic.count, projectId: gMusic.projectId || undefined,
            instrumental: gMusic.instrumental,
            structure: gMusic.structure || undefined
          };
          if (gMusic.mode === "standard") {
            spec.genres = gMusic.genres.join(", ");
            spec.instruments = gMusic.instruments.join(", ");
            spec.bpm = gMusic.bpm || undefined;
            spec.vocal = gMusic.instrumental ? "" : gMusic.vocal;
            spec.lyrics = gMusic._dirtyLyrics ? gMusic.lyrics : undefined;
          }
          if (gMusic.mode === "expert") {
            spec.tags = gMusic.freeTags || undefined;      // 专家自由 tags 直接作 base 覆写
            spec.genres = gMusic.genres.join(", ");
            spec.instruments = gMusic.instruments.join(", ");
            spec.bpm = gMusic.bpm || undefined;
            spec.vocal = gMusic.instrumental ? "" : gMusic.vocal;
            spec.lyrics = gMusic.lyrics;
            spec.caption = gMusic.caption || undefined;
          }
          const r = await store.studioGenerateMusic(spec);
          mWarns.value = (r && r.warnings) || [];
          startPolling(60);
          goTab("drafts");
        } catch (e) { /* toast 已发 */ }
        finally { mBusy.value = false; }
      }

      const musicFilter = Vue.reactive({ q: "", type: "", mood: "" });
      const musicList = Vue.computed(() => {
        let arr = lib.value.music || [];
        if (musicFilter.type) arr = arr.filter(m => m.type === musicFilter.type);
        if (musicFilter.mood) arr = arr.filter(m => m.mood === musicFilter.mood);
        if (musicFilter.q) { const n = musicFilter.q.toLowerCase(); arr = arr.filter(m => JSON.stringify(m).toLowerCase().indexOf(n) >= 0); }
        return arr;
      });

      /* 绑定面：场景/集候选（绑定目标来自全局 state） */
      const sceneOptions = Vue.computed(() => {
        const s = store.state;
        const out = [];
        if (s && s.scenes_by_episode) {
          Object.keys(s.scenes_by_episode).forEach(eid => {
            (s.scenes_by_episode[eid] || []).forEach(sc => {
              const ep = (s.episodes || {})[eid];
              out.push({ id: sc.id, label: (ep ? ep.title + " · " : "") + sc.name });
            });
          });
        }
        return out;
      });
      const bindPick = Vue.reactive({});
      const bindPrimary = Vue.reactive({});
      async function bindMusic(m) {
        const target = bindPick[m.id];
        if (!target) return;
        await store.studioBind("music", m.id, "scene", target, !!bindPrimary[m.id]);
        store.loadStudioDomain("music").catch(() => {});
      }
      async function unbindMusic(m, u) { await store.studioUnbind("music", m.id, u.kind, u.id); }
      async function rateMusic(m, r) { await store.studioPatch("music", m.id, { rating: r }); }
      async function retireMusic(m) {
        const ok = await store.confirm({ title: "淘汰这首曲？（保留引用记录，可回滚）", okLabel: "确认淘汰" });
        if (ok) await store.studioPatch("music", m.id, { status: "retired", force: true });
      }
      const usedBySheet = Vue.ref(null);
      async function showUsedBy(domain, id) {
        const rows = await store.studioUsedBy(domain, id);
        usedBySheet.value = { id, rows };
      }

      /* ================= 图像域（专业配置对齐音乐：预设/标准/专家＋AI 辅助） ================= */
      const gImage = Vue.reactive({
        mode: "standard", type: "establishing", idea: "", desc: "",
        size: "远景", light: "", ratio: "9:16", styleLook: "", refImage: "", negativeExtra: "",
        count: 1, projectId: ""
      });
      const iBusy = Vue.ref(false);
      const imgPreset = Vue.computed(() => IMAGE_TYPES.find(t => t.v === gImage.type) || {});
      async function genImage() {
        const desc = (gImage.mode === "quick" ? gImage.idea : gImage.desc).trim();
        if (iBusy.value || !desc) return;
        iBusy.value = true;
        try {
          const spec = { type: gImage.type, desc, styleLook: gImage.styleLook || undefined, ratio: gImage.ratio, count: gImage.count, projectId: gImage.projectId || undefined };
          if (gImage.mode !== "quick") {
            spec.size = gImage.size;
            spec.light = gImage.light || undefined;
            spec.refImage = gImage.refImage.trim() || undefined;
          }
          if (gImage.mode === "expert") spec.negativeExtra = gImage.negativeExtra.trim() || undefined;
          await store.studioGenerateImage(spec);
          startPolling(60);
          goTab("drafts");
        } catch (e) { /* toast 已发 */ }
        finally { iBusy.value = false; }
      }

      /* ---- AI 辅助（歌词扩写/画面提示词；服务端 ctx.llm，离线 503 如实提示） ---- */
      const aiMusicBusy = Vue.ref(false);
      const aiImgBusy = Vue.ref(false);
      const assistPaste = Vue.ref("");
      const assistShow = Vue.ref(false);
      async function aiLyrics() {
        if (aiMusicBusy.value) return;
        const paste = String(assistPaste.value || gMusic.lyrics || "").trim();
        if (!paste) { mWarns.value = ["先在下方粘贴素材（歌词碎片/一段话/主题描述），或直接在编辑器里写草稿"]; return; }
        aiMusicBusy.value = true; mWarns.value = [];
        try {
          const r = await store.studioAiLyrics({
            paste, type: gMusic.type, mood: effMood.value || "释然",
            style: gMusic.genres.join(", ") || gMusic.freeTags || "",
            sec: gMusic.sec, instrumental: gMusic.instrumental
          });
          gMusic.lyrics = r.lyrics || "";
          gMusic._dirtyLyrics = true;
          mWarns.value = r.warnings || [];
          assistShow.value = false;
          store.toast("AI 已扩写并结构化——记得过一遍再生成");
        } catch (e) { /* store 已 toast */ }
        finally { aiMusicBusy.value = false; }
      }
      async function aiImage() {
        if (aiImgBusy.value) return;
        const idea = String(gImage.mode === "quick" ? gImage.idea : (gImage.desc || gImage.idea)).trim();
        if (!idea) { store.toast("先写一句画面想法，AI 再帮你扩成专业描述", "warn"); return; }
        aiImgBusy.value = true;
        try {
          const r = await store.studioAiImage({ idea, type: gImage.type, styleLook: gImage.styleLook || "", ratio: gImage.ratio });
          if (gImage.mode === "quick") { gImage.mode = "standard"; }
          gImage.desc = r.desc || "";
          if (r.negative) gImage.negativeExtra = r.negative;
          store.toast("AI 已按四层规范扩写画面——可在编辑器里继续改");
        } catch (e) { /* store 已 toast */ }
        finally { aiImgBusy.value = false; }
      }
      const adoptPick = Vue.reactive({});
      async function adoptImage(d) {
        const pick = String(adoptPick[d.id] || "");
        const payload = {};
        if (pick.indexOf("chr:") === 0) payload.attachCharacter = pick.slice(4);
        else if (pick.indexOf("scn:") === 0) {
          payload.attachScene = pick.slice(4);
          if (d.variantHint) payload.variantTag = d.variantHint;
        }
        await store.studioAdoptDraft("images", d.id, payload);
        adoptPick[d.id] = "";
      }
      const imgFilter = Vue.reactive({ q: "", type: "" });
      const imageList = Vue.computed(() => {
        let arr = lib.value.images || [];
        if (imgFilter.type) arr = arr.filter(m => m.type === imgFilter.type);
        if (imgFilter.q) { const n = imgFilter.q.toLowerCase(); arr = arr.filter(m => JSON.stringify(m).toLowerCase().indexOf(n) >= 0); }
        return arr;
      });
      async function rateImage(m, r) { await store.studioPatch("images", m.id, { rating: r }); }
      async function retireImage(m) {
        const ok = await store.confirm({ title: "淘汰这张图？（保留引用记录）", okLabel: "确认淘汰" });
        if (ok) await store.studioPatch("images", m.id, { status: "retired", force: true });
      }
      /* 上传 */
      const upFile = Vue.ref(null);
      const upMeta = Vue.reactive({ title: "", licenseModel: "自持授权", licenseUsage: "ok" });
      async function doUpload() {
        const f = upFile.value;
        if (!f) return;
        await store.studioUpload(tab.value === "images" ? "images" : "images", f, { title: upMeta.title || f.name, licenseModel: upMeta.licenseModel, licenseUsage: upMeta.licenseUsage });
        upFile.value = null;
      }

      /* ================= 角色域 ================= */
      const exPick = Vue.reactive({ episodeId: "", role: "" });
      const exRoles = Vue.computed(() => {
        const ep = episodes.value.filter(e => e.id === exPick.episodeId)[0];
        const cast = (ep && ep.script && ep.script.cast) || [];
        return cast.map(c => c.role).filter(Boolean);
      });
      async function extractChar() {
        if (!exPick.episodeId || !exPick.role) return;
        await store.studioExtractCharacter(exPick.episodeId, exPick.role);
        exPick.episodeId = ""; exPick.role = "";
      }
      async function promoteFrames(ch) {
        const eps = (ch.used_by || []).filter(u => u.kind === "episode");
        const eid = eps.length ? eps[0].id : (episodes.value[0] && episodes.value[0].id);
        if (!eid) return;
        await store.studioPromoteFrames(ch.id, eid, ch.role);
      }
      async function recast(ch) { await store.studioRecast(ch.id); }

      /* ================= 场景域 ================= */
      const gScene = Vue.reactive({ name: "", mood: "中性", envDesc: "", lightPreset: "", projectId: "" });
      async function createScene() {
        if (!gScene.name.trim()) return;
        await store.studioCreateScene({
          name: gScene.name.trim(), mood: gScene.mood, envDesc: gScene.envDesc.trim(),
          lightPreset: gScene.lightPreset.trim(), projectId: gScene.projectId || undefined
        });
        gScene.name = ""; gScene.envDesc = ""; gScene.lightPreset = "";
      }
      const estVariant = Vue.reactive({});
      async function genEstablishing(sc) {
        await store.studioEstablishing(sc.id, estVariant[sc.id] || null);
        startPolling(60);
      }

      /* ================= 设定域 ================= */
      const canonLists = Vue.reactive({ style_pkgs: [], reject_rules: [], lore: [] });
      const gCanon = Vue.reactive({ look: "", t2iSuffix: "", musicTags: "", ruleTitle: "", ruleContent: "", loreTitle: "", loreContent: "" });
      async function loadCanon() {
        canonLists.style_pkgs = await store.studioCanon("style_pkgs");
        canonLists.reject_rules = await store.studioCanon("reject_rules");
        canonLists.lore = await store.studioCanon("lore");
      }
      async function saveStylePkg() {
        if (!gCanon.look.trim()) return;
        await store.studioSaveCanon("style_pkgs", { look: gCanon.look.trim(), t2i_suffix: gCanon.t2iSuffix.trim(), music_tags: gCanon.musicTags.trim() });
        gCanon.look = ""; gCanon.t2iSuffix = ""; gCanon.musicTags = "";
        loadCanon();
      }
      async function saveRule(kind) {
        const t = kind === "reject_rules" ? gCanon.ruleTitle : gCanon.loreTitle;
        const c = kind === "reject_rules" ? gCanon.ruleContent : gCanon.loreContent;
        if (!t.trim() || !c.trim()) return;
        await store.studioSaveCanon(kind, { title: t.trim(), content: c.trim() });
        if (kind === "reject_rules") { gCanon.ruleTitle = ""; gCanon.ruleContent = ""; }
        else { gCanon.loreTitle = ""; gCanon.loreContent = ""; }
        loadCanon();
      }

      /* ================= 候选池 ================= */
      async function adoptMusic(d) { await store.studioAdoptDraft("music", d.id, {}); }
      async function discardDraft(domain, id) { await store.studioDiscardDraft(domain, id); }
      const draftsAll = Vue.computed(() => (drafts.value.music || []).concat((drafts.value.images || []).map(d => Object.assign({}, d, { _domain: "images" }))));
      function draftDomain(d) { return d.domain || d._domain || "music"; }

      return {
        TABS, MUSIC_TYPES, MUSIC_MODES, MUSIC_GENRES, MUSIC_INSTRUMENTS, MUSIC_VOCALS, MUSIC_TYPE_PRESETS, LYRIC_MARKS,
        IMAGE_TYPES, IMAGE_SIZES, IMAGE_LIGHTS, LOOKS, MOODS, SECS,
        tab, goTab, summary, drafts, lib, projects, episodes, srcOf, fmtSec,
        preview, openPreview, closePreview, audioFail,
        gMusic, mBusy, mWarns, preset, effMood, genMusic, toggleChip, applyPreset, resetPreset, insLyric, markLyricsDirty,
        assistPaste, assistShow, aiMusicBusy, aiLyrics, aiImgBusy, aiImage,
        gMusic, mBusy, mWarns, preset, effMood, genMusic, toggleChip, applyPreset, resetPreset, insLyric, markLyricsDirty,
        musicFilter, musicList,
        gImage, iBusy, imgPreset, genImage,
        sceneOptions, bindPick, bindPrimary, bindMusic, unbindMusic, rateMusic, retireMusic, usedBySheet, showUsedBy,
        adoptPick, adoptImage, imgFilter, imageList, rateImage, retireImage,
        upFile, upMeta, doUpload,
        exPick, exRoles, extractChar, promoteFrames, recast,
        gScene, createScene, estVariant, genEstablishing,
        canonLists, gCanon, loadCanon, saveStylePkg, saveRule,
        adoptMusic, discardDraft, draftsAll, draftDomain
      };
    },
    template: `
      <div class="v-studio">
        <div class="panel">
          <div class="panel-title">素材中心 <span class="weak">先攒库、再开拍——生成 → 候选池筛选 → 入库 → 绑定消费</span>
            <span class="weak" v-if="summary">曲 {{summary.counts.music}} · 图 {{summary.counts.images}} · 角色 {{summary.counts.characters}} · 场景 {{summary.counts.scenes}} · 候选 {{summary.counts.drafts}}</span>
          </div>
          <nav class="ep-tabs studio-tabs">
            <a v-for="t in TABS" :key="t.key" :class="{active: tab===t.key}" href="javascript:void(0)" @click="goTab(t.key)">{{ t.label }}</a>
          </nav>
        </div>

        <!-- ================= 音频（专业配置：对齐引擎 tags/lyrics/caption 三通道） ================= -->
        <div class="panel" v-if="tab==='music'">
          <div class="panel-title">生成配乐 <span class="weak">类型预设打底，标准配置曲风/乐器/人声/BPM，专家直写 tags 与结构化歌词</span></div>

          <!-- 类型预设（驱动默认值） -->
          <div class="v-music-presets">
            <button v-for="t in MUSIC_TYPES" :key="t.v" type="button" class="v-music-preset" :class="{on: gMusic.type===t.v}" @click="gMusic.type=t.v">
              <b>{{ t.label }}</b>
              <span class="weak">{{ (MUSIC_TYPE_PRESETS[t.v]||{}).hint }}</span>
            </button>
          </div>

          <!-- 模式切换 -->
          <div class="v-music-modes">
            <button v-for="m in MUSIC_MODES" :key="m.v" type="button" class="v-music-mode" :class="{on: gMusic.mode===m.v}" @click="gMusic.mode=m.v">{{ m.label }}</button>
            <span class="weak">{{ (MUSIC_MODES.find(m=>m.v===gMusic.mode)||{}).hint }}</span>
          </div>

          <div class="v-studio-gen">
            <label class="field" v-if="gMusic.mode==='quick' || true"><span class="field-label">情绪基调</span>
              <select class="select" v-model="gMusic.mood"><option v-for="m in MOODS" :key="m" :value="m">{{ m==='其它'?'其它（自填）':m }}</option></select></label>
            <label class="field"><span class="field-label">时长</span>
              <select class="select" v-model="gMusic.sec"><option :value="15">15 秒</option><option :value="30">30 秒</option><option :value="45">45 秒</option><option :value="60">60 秒</option><option :value="90">90 秒</option><option :value="120">120 秒</option></select></label>
            <label class="field"><span class="field-label">批数（每批 3 段）</span>
              <select class="select" v-model="gMusic.count"><option :value="1">1 批</option><option :value="2">2 批</option><option :value="3">3 批</option></select></label>
            <label class="field"><span class="field-label">归属项目（可空＝公共库）</span>
              <select class="select" v-model="gMusic.projectId"><option value="">公共库（跨项目）</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}</option></select></label>
            <label class="field" v-if="gMusic.mood==='其它'"><span class="field-label">自填情绪</span>
              <input class="input" v-model.trim="gMusic.moodOther" maxlength="12" /></label>
          </div>

          <!-- 标准/专家：结构化配置 -->
          <div v-if="gMusic.mode!=='quick'" class="v-music-config">
            <div class="v-studio-fieldrow">
              <span class="field-label">人声</span>
              <div class="v-studio-chips">
                <button v-for="v in MUSIC_VOCALS" :key="v.v" type="button" class="chip" :class="{on: gMusic.instrumental ? v.v==='' : gMusic.vocal===v.v}" @click="if (v.v==='') { gMusic.instrumental = true; } else { gMusic.instrumental = false; gMusic.vocal = v.v; }">{{ v.label }}</button>
              </div>
            </div>
            <div class="v-studio-fieldrow">
              <span class="field-label">曲风</span>
              <div class="v-studio-chips">
                <button v-for="g in MUSIC_GENRES" :key="g" type="button" class="chip" :class="{on: gMusic.genres.indexOf(g)>=0}" @click="toggleChip(gMusic.genres, g)">{{ g }}</button>
              </div>
            </div>
            <div class="v-studio-fieldrow">
              <span class="field-label">乐器</span>
              <div class="v-studio-chips">
                <button v-for="g in MUSIC_INSTRUMENTS" :key="g" type="button" class="chip" :class="{on: gMusic.instruments.indexOf(g)>=0}" @click="toggleChip(gMusic.instruments, g)">{{ g }}</button>
              </div>
            </div>
            <div class="v-studio-gen" style="margin-top:4px;">
              <label class="field"><span class="field-label">BPM（可空）</span>
                <input class="input" v-model.trim="gMusic.bpm" maxlength="3" placeholder="60–180" inputmode="numeric" /></label>
              <label class="field" v-if="gMusic.mode==='expert'"><span class="field-label">自由 tags（覆写一切）</span>
                <input class="input" v-model.trim="gMusic.freeTags" maxlength="300" placeholder="例：melancholic piano ballad, rain ambience, 72 bpm" /></label>
              <label class="field" v-if="gMusic.mode==='expert'" style="grid-column: 2 / 5;"><span class="field-label">自然语言描述（caption 通道）</span>
                <input class="input" v-model.trim="gMusic.caption" maxlength="400" :placeholder="preset.captionHint || '例：A melancholic piano ballad, rain atmosphere, building to a string climax'" /></label>
            </div>
            <!-- 歌词 / 结构段编辑器（AI 扩写：粘贴素材 → 按模型特性结构化） -->
            <div class="v-music-lyrics">
              <div class="v-music-lyrics-head">
                <span class="field-label">{{ gMusic.instrumental ? '结构段标记（纯音乐）' : '歌词编辑器（[段标记] 控制结构）' }}</span>
                <button type="button" class="chip chip-ai" :disabled="aiMusicBusy" @click="aiLyrics()" title="把素材按 ACE-Step 特性扩写成结构化歌词">
                  {{ aiMusicBusy ? 'AI 扩写中…' : '✨ AI 扩写' }}</button>
                <span class="weak" v-if="!gMusic.instrumental">快捷插入：</span>
                <template v-if="!gMusic.instrumental">
                  <button v-for="mk in LYRIC_MARKS" :key="mk" type="button" class="chip chip-sm" @click="insLyric(mk)">{{ mk }}</button>
                </template>
                <button type="button" class="chip" @click="resetPreset()" title="恢复该类型预设默认">↺ 恢复预设</button>
              </div>
              <div class="v-assist-paste" v-if="assistShow">
                <textarea class="input v-music-lyrics-box" v-model="assistPaste" rows="4"
                  placeholder="把素材粘到这里：歌词碎片、一段故事、主题描述都行——AI 会按 [段标记] 结构扩写（编辑器里有草稿时留空即以草稿为素材）" spellcheck="false"></textarea>
              </div>
              <textarea class="input v-music-lyrics-box" v-model="gMusic.lyrics" @input="markLyricsDirty" rows="8"
                :placeholder="gMusic.instrumental ? preset.structureLine : '写歌词正文；用 [Verse]/[Chorus] 等段标记控制结构'" spellcheck="false"></textarea>
              <div class="weak" style="margin-top:4px">结构段：{{ gMusic.structure }}</div>
              <div class="v-music-acts" style="margin-top:6px">
                <button type="button" class="btn btn-sm" @click="assistShow = !assistShow">{{ assistShow ? '收起素材粘贴' : '📎 粘贴素材给 AI' }}</button>
                <span class="weak">AI 扩写 = 以粘贴素材（或编辑器草稿）为底，按引擎段标记规范出完整结构化歌词</span>
              </div>
            </div>
          </div>

          <div class="v-music-acts">
            <button class="btn btn-primary" :disabled="mBusy" @click="genMusic">{{ mBusy ? '排队中…' : '生成候选（' + (gMusic.count * 3) + ' 段）' }}</button>
            <span class="weak">{{ preset.hint }} · {{ gMusic.instrumental ? '纯音乐' : (gMusic.vocal || '未选人声') }}</span>
          </div>
          <div class="v-music-warns" v-if="mWarns.length">
            <div v-for="(w,i) in mWarns" :key="i">⚠ {{ w }}</div>
          </div>

          <div class="panel-title" style="margin-top:14px;">曲库 <span class="weak">评分 · 绑定 · 影响面</span></div>
          <div class="v-studio-filters">
            <input class="input" v-model.trim="musicFilter.q" placeholder="搜标题/标签…" style="max-width:220px" />
            <select class="select" v-model="musicFilter.type" style="max-width:150px"><option value="">全部类型</option><option v-for="t in MUSIC_TYPES" :key="t.v" :value="t.v">{{ t.label }}</option></select>
            <select class="select" v-model="musicFilter.mood" style="max-width:130px"><option value="">全部心情</option><option v-for="m in MOODS" :key="m" :value="m">{{ m }}</option></select>
            <button class="btn btn-sm" @click="doUpload()" title="从本机上传授权音频">⬆ 上传音频</button>
            <input type="file" accept="audio/*,.wav,.mp3" @change="e => { upFile = e.target.files[0]; if (upFile) doUpload(); }" style="max-width:220px" />
          </div>
          <empty-state v-if="!musicList.length" icon="🎵" text="曲库还是空的" sub="上面生成候选，或上传自有授权音频。"></empty-state>
          <div class="table-scroll" v-else>
            <table class="table">
              <thead><tr><th>曲目</th><th>类型</th><th>心情</th><th>时长</th><th>许可</th><th>评分</th><th>试听</th><th>绑定/影响面</th><th></th></tr></thead>
              <tbody>
                <tr v-for="m in musicList" :key="m.id">
                  <td><b>{{ m.title }}</b><div class="weak" v-if="m.tags">{{ m.tags }}</div></td>
                  <td><span class="badge">{{ (MUSIC_TYPES.find(t=>t.v===m.type)||{}).label || m.type }}</span></td>
                  <td><span class="badge">{{ m.mood }}</span></td>
                  <td class="num">{{ fmtSec(m.sec) }}</td>
                  <td><license-badge :license="m.license"></license-badge></td>
                  <td class="num"><span class="v-studio-rate" role="button" :title="'当前 '+m.rating+' 星，点击改 5 星'" @click="rateMusic(m, m.rating>=5?0:5)">{{ '★'.repeat(m.rating||0) || '☆' }}</span></td>
                  <td><audio v-if="m.art" controls preload="none" :src="srcOf(m.art)" style="max-width:170px;height:28px"></audio><span v-else class="weak">无文件</span></td>
                  <td>
                    <div class="v-studio-bind" v-for="u in (m.used_by||[])" :key="u.kind+u.id">
                      <span class="badge" :class="{'badge-ok': u.primary}">{{ u.kind==='scene'?'场':'集' }}:{{ u.id }}{{ u.primary?' · 主':'' }}</span>
                      <button class="btn btn-sm btn-ghost" @click="unbindMusic(m,u)">✕</button>
                    </div>
                    <div class="row">
                      <select class="select v-studio-sel" v-model="bindPick[m.id]"><option value="">绑到场景…</option><option v-for="sc in sceneOptions" :key="sc.id" :value="sc.id">{{ sc.label }}</option></select>
                      <label class="v-studio-prim"><input type="checkbox" v-model="bindPrimary[m.id]" /> 主曲</label>
                      <button class="btn btn-sm" :disabled="!bindPick[m.id]" @click="bindMusic(m)">绑</button>
                      <button class="btn btn-sm btn-ghost" @click="showUsedBy('music', m.id)">影响面</button>
                    </div>
                  </td>
                  <td><button class="btn btn-sm btn-ghost" @click="retireMusic(m)">淘汰</button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="weak" v-if="usedBySheet" style="margin-top:8px">
            影响面（{{ usedBySheet.id }}）：<span v-for="(u,i) in usedBySheet.rows" :key="i">{{ u.kind }}:{{ u.name || u.id }}{{ u.primary?'（主）':'' }}　</span>
            <button class="btn btn-sm btn-ghost" @click="usedBySheet=null">收起</button>
          </div>
        </div>

        <!-- ================= 图像（专业配置：类型预设＋三模式＋AI 写画面） ================= -->
        <div class="panel" v-if="tab==='images'">
          <div class="panel-title">生成图像 <span class="weak">类型预设＋景别/光线配置＋AI 按四层规范扩写画面——质量来自结构化描述，不是一句话碰运气</span></div>

          <!-- 类型预设卡片 -->
          <div class="v-music-presets">
            <button v-for="t in IMAGE_TYPES" :key="t.v" type="button" class="v-music-preset" :class="{on: gImage.type===t.v}" @click="gImage.type=t.v">
              <b>{{ t.label }}</b>
              <span class="weak">{{ t.hint }}</span>
            </button>
          </div>

          <!-- 模式切换 -->
          <div class="v-music-modes">
            <button v-for="m in [{v:'quick',label:'快速',hint:'一句话想法直接生成'},{v:'standard',label:'标准',hint:'四层描述＋景别/光线/参考图'},{v:'expert',label:'专家',hint:'完整描述编辑器＋负面增补'}]" :key="m.v" type="button"
              class="v-music-mode" :class="{on: gImage.mode===m.v}" @click="gImage.mode=m.v">{{ m.label }}</button>
            <span class="weak">{{ gImage.mode==='quick' ? '一句话想法直接生成' : gImage.mode==='standard' ? '四层描述＋景别/光线/参考图' : '完整描述编辑器＋负面增补' }}</span>
          </div>

          <div class="v-studio-gen">
            <label class="field" style="grid-column:1/3" v-if="gImage.mode==='quick'"><span class="field-label">画面想法（一句话）</span>
              <input class="input" v-model.trim="gImage.idea" maxlength="400" placeholder="例：雨夜的码头，集装箱剪影，很压抑" /></label>
            <label class="field"><span class="field-label">风格包</span>
              <select class="select" v-model="gImage.styleLook"><option value="">跟随项目/默认</option><option v-for="l in LOOKS" :key="l" :value="l">{{ l }}</option></select></label>
            <label class="field"><span class="field-label">画幅</span>
              <select class="select" v-model="gImage.ratio"><option value="9:16">9:16 竖屏</option><option value="16:9">16:9 横屏</option><option value="1:1">1:1 方图</option></select></label>
            <label class="field"><span class="field-label">张数</span>
              <select class="select" v-model="gImage.count"><option :value="1">1 张</option><option :value="2">2 张</option><option :value="3">3 张</option><option :value="4">4 张</option></select></label>
            <label class="field"><span class="field-label">归属项目（可空＝公共库）</span>
              <select class="select" v-model="gImage.projectId"><option value="">公共库（跨项目）</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}</option></select></label>
          </div>

          <div v-if="gImage.mode!=='quick'" class="v-music-config">
            <div class="v-studio-fieldrow">
              <span class="field-label">景别</span>
              <div class="v-studio-chips">
                <button v-for="s in IMAGE_SIZES" :key="s" type="button" class="chip" :class="{on: gImage.size===s}" @click="gImage.size=s">{{ s }}</button>
              </div>
            </div>
            <div class="v-studio-fieldrow">
              <span class="field-label">光线</span>
              <div class="v-studio-chips">
                <button v-for="l in IMAGE_LIGHTS" :key="l.v" type="button" class="chip" :class="{on: gImage.light===l.v}" @click="gImage.light=l.v">{{ l.label }}</button>
                <button type="button" class="chip" :class="{on: !gImage.light}" @click="gImage.light=''">跟随情绪/描述</button>
              </div>
            </div>
            <label class="field" style="width:100%"><span class="field-label">画面描述（四层：主体动作 → 环境道具 → 光线时间 → 氛围）</span>
              <textarea class="input v-music-lyrics-box" v-model="gImage.desc" rows="4" maxlength="800"
                placeholder="例：女主攥着湿透的信封在码头疾走，频频回头；集装箱林立，积水反着路灯；冷蓝夜雨，路灯光晕；压抑急促" spellcheck="false"></textarea></label>
            <div class="v-studio-gen" style="margin-top:4px;">
              <label class="field" style="grid-column:1/3"><span class="field-label">参考图（可空，库内路径——即梦式挂载）</span>
                <input class="input" v-model.trim="gImage.refImage" maxlength="200" placeholder="var/assets/library/images/xxx.png 或 var/assets/cast/xxx.png" /></label>
              <label class="field" v-if="gImage.mode==='expert'" style="grid-column:3/5"><span class="field-label">负面增补（可空，逗号分隔）</span>
                <input class="input" v-model.trim="gImage.negativeExtra" maxlength="200" placeholder="例：文字, 水印, 多人" /></label>
            </div>
          </div>

          <div class="v-music-acts">
            <button type="button" class="chip chip-ai" :disabled="aiImgBusy" @click="aiImage()" :title="gImage.mode==='quick' ? '把一句话想法按四层规范扩写成专业描述' : '把当前描述按四层规范润色扩写'">
              {{ aiImgBusy ? 'AI 写画面中…' : '✨ AI 写画面' }}</button>
            <button class="btn btn-primary" :disabled="iBusy || !(gImage.mode==='quick' ? gImage.idea.trim() : gImage.desc.trim())" @click="genImage">{{ iBusy ? '排队中…' : '生成候选（' + gImage.count + ' 张）' }}</button>
            <span class="weak">{{ imgPreset.hint }}</span>
          </div>

          <div class="panel-title" style="margin-top:14px;">图库</div>
          <div class="v-studio-filters">
            <input class="input" v-model.trim="imgFilter.q" placeholder="搜描述…" style="max-width:220px" />
            <select class="select" v-model="imgFilter.type" style="max-width:150px"><option value="">全部类型</option><option v-for="t in IMAGE_TYPES" :key="t.v" :value="t.v">{{ t.label }}</option></select>
          </div>
          <empty-state v-if="!imageList.length" icon="🖼" text="图库还是空的" sub="上面生成候选，或去「候选池」收藏。"></empty-state>
          <div class="v-studio-grid" v-else>
            <div class="card v-studio-img" v-for="m in imageList" :key="m.id">
              <img v-if="m.art" :src="srcOf(m.art)" loading="lazy" alt="" style="cursor:zoom-in" title="点击放大预览" @click="openPreview(m.art, m.title || m.desc)" />
              <div class="v-studio-img-meta">
                <b>{{ m.title }}</b> <span class="badge">{{ (IMAGE_TYPES.find(t=>t.v===m.type)||{}).label || m.type }}</span>
                <div class="weak">{{ m.desc }}</div>
                <div class="row">
                  <span class="v-studio-rate" role="button" @click="rateImage(m, m.rating>=5?0:5)">{{ '★'.repeat(m.rating||0) || '☆' }}</span>
                  <button class="btn btn-sm btn-ghost" @click="retireImage(m)">淘汰</button>
                  <button class="btn btn-sm btn-ghost" @click="showUsedBy('images', m.id)">影响面</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ================= 角色 ================= -->
        <div class="panel" v-if="tab==='characters'">
          <div class="panel-title">角色库 <span class="weak">锚点＋定妆＋帧池＋版本；从集里提取或直接维护</span></div>
          <div class="v-studio-gen">
            <label class="field"><span class="field-label">从集提取角色（生产回流）</span>
              <select class="select" v-model="exPick.episodeId"><option value="">选集…</option><option v-for="e in episodes" :key="e.id" :value="e.id">{{ e.title }}</option></select></label>
            <label class="field"><span class="field-label">角色</span>
              <select class="select" v-model="exPick.role" :disabled="!exPick.episodeId"><option value="">选角色…</option><option v-for="r in exRoles" :key="r" :value="r">{{ r }}</option></select></label>
            <div class="v-studio-acts"><button class="btn" :disabled="!exPick.episodeId || !exPick.role" @click="extractChar">提取入库</button></div>
          </div>
          <empty-state v-if="!(lib.characters||[]).length" icon="👤" text="角色库还是空的" sub="把集里定妆过的角色提取进来，跨集跨季复用。"></empty-state>
          <div class="v-studio-grid" v-else>
            <div class="card v-studio-img" v-for="ch in lib.characters" :key="ch.id">
              <img v-if="ch.refImage" :src="srcOf(ch.refImage)" loading="lazy" alt=""
                :title="ch.refImage" @error="e => e.target.style.display='none'" />
              <span v-else class="v-studio-norefwarn">⏳ 还没有定妆图：去集里完成定妆后「提取入库」或「重定妆」</span>
              <div class="v-studio-img-meta">
                <b>{{ ch.role }}</b> <span class="badge">{{ ch.gender }}</span> <span class="badge">{{ (ch.versions||[]).length }} 版</span>
                <div class="weak">{{ ch.anchor }}</div>
                <div class="weak">帧池 {{ (ch.views||[]).length }} 帧 · 服装 {{ (ch.wardrobe||[]).length }} 套</div>
                <div class="row">
                  <button class="btn btn-sm" @click="promoteFrames(ch)">帧池入库</button>
                  <button class="btn btn-sm" @click="recast(ch)">重定妆</button>
                  <button class="btn btn-sm btn-ghost" @click="showUsedBy('characters', ch.id)">影响面</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ================= 场景 ================= -->
        <div class="panel" v-if="tab==='scenes'">
          <div class="panel-title">场景库 <span class="weak">场景卡＝定场图＋光线预设＋环境音＋变体</span></div>
          <div class="v-studio-gen">
            <label class="field"><span class="field-label">场景名</span>
              <input class="input" v-model.trim="gScene.name" maxlength="40" placeholder="例：灯塔平台" /></label>
            <label class="field"><span class="field-label">氛围</span>
              <select class="select" v-model="gScene.mood"><option v-for="m in MOODS" :key="m" :value="m">{{ m }}</option></select></label>
            <label class="field"><span class="field-label">光线预设（可空）</span>
              <input class="input" v-model.trim="gScene.lightPreset" maxlength="120" placeholder="例：冷蓝夜雨，灯塔扫光" /></label>
            <label class="field" style="grid-column:1/3"><span class="field-label">环境描述</span>
              <input class="input" v-model.trim="gScene.envDesc" maxlength="300" placeholder="例：礁石平台，风大浪急，远处海面" /></label>
            <div class="v-studio-acts"><button class="btn btn-primary" :disabled="!gScene.name.trim()" @click="createScene">建场景卡</button></div>
          </div>
          <empty-state v-if="!(lib.scenes||[]).length" icon="🏞" text="场景库还是空的" sub="建场景卡、出定场图，跨集复用同一场景。"></empty-state>
          <div class="v-studio-grid" v-else>
            <div class="card v-studio-img" v-for="sc in lib.scenes" :key="sc.id">
              <img v-if="sc.establishing" :src="srcOf(sc.establishing)" loading="lazy" alt="" />
              <div class="v-studio-img-meta">
                <b>{{ sc.name }}</b> <span class="badge">{{ sc.mood }}</span>
                <div class="weak">{{ sc.env_desc }}</div>
                <div class="weak" v-if="sc.light_preset">光线：{{ sc.light_preset }}</div>
                <div class="weak" v-if="(sc.variants||[]).length">变体：{{ sc.variants.map(v=>v.tag).join('、') }}</div>
                <div class="row">
                  <input class="input v-studio-sel" v-model.trim="estVariant[sc.id]" maxlength="12" placeholder="变体（夜/雨）" />
                  <button class="btn btn-sm" @click="genEstablishing(sc)">出定场图</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ================= 设定 ================= -->
        <div class="panel" v-if="tab==='canon'" @vue:mounted="loadCanon">
          <div class="panel-title">设定域 <span class="weak">剧集圣经：风格包多包管理 / 判废表 / 世界观</span></div>
          <div class="v-studio-canons">
            <div>
              <div class="v-studio-sec">风格包（{{ canonLists.style_pkgs.length }}）</div>
              <div class="v-studio-gen">
                <label class="field"><span class="field-label">风格名 look</span><input class="input" v-model.trim="gCanon.look" maxlength="30" /></label>
                <label class="field"><span class="field-label">t2i 风格后缀</span><input class="input" v-model.trim="gCanon.t2iSuffix" maxlength="300" /></label>
                <label class="field"><span class="field-label">配乐 tags</span><input class="input" v-model.trim="gCanon.musicTags" maxlength="200" /></label>
                <div class="v-studio-acts"><button class="btn btn-primary" :disabled="!gCanon.look.trim()" @click="saveStylePkg">保存风格包</button></div>
              </div>
              <div class="weak" v-for="sp in canonLists.style_pkgs" :key="sp.id">· {{ sp.look }}　{{ sp.t2i_suffix }}</div>
            </div>
            <div>
              <div class="v-studio-sec">判废表（{{ canonLists.reject_rules.length }}）</div>
              <div class="v-studio-gen">
                <label class="field"><span class="field-label">条目名</span><input class="input" v-model.trim="gCanon.ruleTitle" maxlength="60" /></label>
                <label class="field" style="grid-column:1/3"><span class="field-label">判废标准</span><input class="input" v-model.trim="gCanon.ruleContent" maxlength="500" /></label>
                <div class="v-studio-acts"><button class="btn" @click="saveRule('reject_rules')">保存判废条目</button></div>
              </div>
              <div class="weak" v-for="r in canonLists.reject_rules" :key="r.id">· {{ r.title }}：{{ r.content }}</div>
            </div>
            <div>
              <div class="v-studio-sec">世界观/人物小传（{{ canonLists.lore.length }}）</div>
              <div class="v-studio-gen">
                <label class="field"><span class="field-label">标题</span><input class="input" v-model.trim="gCanon.loreTitle" maxlength="60" /></label>
                <label class="field" style="grid-column:1/3"><span class="field-label">内容</span><input class="input" v-model.trim="gCanon.loreContent" maxlength="500" /></label>
                <div class="v-studio-acts"><button class="btn" @click="saveRule('lore')">保存设定</button></div>
              </div>
              <div class="weak" v-for="l in canonLists.lore" :key="l.id">· {{ l.title }}：{{ l.content }}</div>
            </div>
          </div>
        </div>

        <!-- ================= 候选池 ================= -->
        <div class="panel" v-if="tab==='drafts'">
          <div class="panel-title">候选池 <span class="weak">生成未入库；评分收藏入库，不要的淘汰（7 天自动清）</span></div>
          <empty-state v-if="!draftsAll.length" icon="📥" text="候选池是空的" sub="去「音频」或「图像」生成一批。"></empty-state>
          <div class="table-scroll" v-else>
            <table class="table">
              <thead><tr><th>候选</th><th>类型</th><th>预览</th><th>许可/成本</th><th>入库动作</th></tr></thead>
              <tbody>
                <tr v-for="d in draftsAll" :key="draftDomain(d)+d.id">
                  <td><b>{{ d.title }}</b><div class="weak" v-if="d.mood">{{ d.mood }} · {{ fmtSec(d.sec) }}</div><div class="weak" v-if="d.tags">{{ d.tags }}</div><div class="weak" v-if="d.desc">{{ d.desc }}</div></td>
                  <td><span class="badge">{{ draftDomain(d)==='music' ? '音频' : '图像' }}</span></td>
                  <td>
                    <template v-if="draftDomain(d)==='music'">
                      <audio v-if="d.art && !audioFail[d.id]" controls preload="none" :src="srcOf(d.art)" style="max-width:170px;height:28px" @error="audioFail[d.id]=true"></audio>
                      <span v-else-if="d.art" class="weak">音频文件不可用（占位或生成失败——音乐生成服务未运行时产物为占位）</span>
                      <span v-else class="weak">生成中…</span>
                    </template>
                    <template v-else>
                      <img v-if="d.art" :src="srcOf(d.art)" loading="lazy" style="max-height:90px;cursor:zoom-in" alt="" title="点击放大预览" @click="openPreview(d.art, d.title || d.desc)" />
                      <span v-else class="weak">生成中…</span>
                    </template>
                  </td>
                  <td><license-badge v-if="d.license" :license="d.license"></license-badge><money v-if="d.shadow_cents" :cents="d.shadow_cents"></money></td>
                  <td>
                    <template v-if="draftDomain(d)==='music'">
                      <button class="btn btn-sm btn-primary" @click="adoptMusic(d)">收藏入库</button>
                    </template>
                    <template v-else>
                      <select class="select v-studio-sel" v-model="adoptPick[d.id]">
                        <option value="">直接入库</option>
                        <option v-for="ch in (lib.characters||[])" :key="'c'+ch.id" :value="'chr:'+ch.id">挂为角色版本</option>
                        <option v-for="sc in (lib.scenes||[])" :key="'s'+sc.id" :value="'scn:'+sc.id">挂为场景定场图</option>
                      </select>
                      <button class="btn btn-sm btn-primary" @click="adoptImage(d)">收藏入库</button>
                    </template>
                    <button class="btn btn-sm btn-ghost" @click="discardDraft(draftDomain(d), d.id)">淘汰</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 灯箱预览（点击遮罩或图关闭；Esc 亦关） -->
        <div class="v-studio-lightbox" v-if="preview" @click.self="closePreview">
          <div class="v-studio-lightbox-inner">
            <img :src="preview.art" alt="" />
            <div class="v-studio-lightbox-t">{{ preview.title }}</div>
            <button class="v-studio-lightbox-x" @click="closePreview" aria-label="关闭预览">✕</button>
          </div>
        </div>
      </div>`
  };
})(window);
