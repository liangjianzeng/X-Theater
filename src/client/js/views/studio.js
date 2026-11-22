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
  /* 值＝引擎英文 tag（发给 ACE-Step）；label＝界面中文（2026-11-22 用户裁决：选项一律中文展示） */
  const MUSIC_GENRES = [
    { v: "pop", label: "流行" }, { v: "ballad", label: "抒情" }, { v: "rock", label: "摇滚" },
    { v: "electronic", label: "电子" }, { v: "synthwave", label: "合成器浪潮" }, { v: "orchestral", label: "管弦" },
    { v: "solo piano", label: "钢琴独奏" }, { v: "strings", label: "弦乐" }, { v: "lo-fi", label: "Lo-fi" },
    { v: "jazz", label: "爵士" }, { v: "r&b", label: "R&B" }, { v: "hip-hop", label: "嘻哈" },
    { v: "folk", label: "民谣" }, { v: "chinese traditional", label: "国风" }, { v: "ambient", label: "环境音乐" },
    { v: "cinematic", label: "影视配乐" }, { v: "city pop", label: "City Pop" }, { v: "blues", label: "蓝调" }
  ];
  const MUSIC_INSTRUMENTS = [
    { v: "piano", label: "钢琴" }, { v: "acoustic guitar", label: "木吉他" }, { v: "electric guitar", label: "电吉他" },
    { v: "strings ensemble", label: "弦乐组" }, { v: "brass", label: "铜管" }, { v: "flute", label: "长笛" },
    { v: "dizi", label: "笛箫" }, { v: "guzheng", label: "古筝" }, { v: "erhu", label: "二胡" },
    { v: "synth pad", label: "合成器 Pad" }, { v: "drums", label: "鼓组" }, { v: "bass", label: "贝斯" },
    { v: "guitar solo", label: "吉他独奏" }, { v: "violin solo", label: "小提琴独奏" }, { v: "hand percussion", label: "手打击乐" }
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
  /* 画幅×清晰度两维（2026-11-22 上传编辑）：ratio 6 档（服务端 util.imgSpecFor 引擎自适应）；
   * 清晰度档 standard≈1MP / hd≈2MP 全高清 / uhd 2048²（仅远端高价值线原生，本机线自动回落） */
  const IMAGE_RATIOS = [
    { v: "9:16", label: "9:16 竖屏（成片标准）" }, { v: "16:9", label: "16:9 横屏" }, { v: "1:1", label: "1:1 方图" },
    { v: "3:4", label: "3:4 竖版" }, { v: "4:3", label: "4:3 横版" }, { v: "21:9", label: "21:9 宽幅" }
  ];
  const IMAGE_TIERS = [
    { v: "standard", label: "标准 ≈1MP" }, { v: "hd", label: "高清 ≈2MP" }, { v: "uhd", label: "超清 2048²·远端" }
  ];
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
      /* audioFail 已并入 StudioAudio 组件内部失败态 */
      global.addEventListener("keydown", function (e) { if (e.key === "Escape") preview.value = null; });
  function fmtSec(s) { return s == null ? "—" : s + " 秒"; }
      /* 词典值→中文标签：引擎收英文 tag，界面只讲中文（2026-11-22 用户裁决）；候选池溯源同表 */
      const GENRE_ZH = {}, INST_ZH = {}, VOCAL_ZH = {};
      MUSIC_GENRES.forEach(g => { GENRE_ZH[g.v] = g.label; });
      MUSIC_INSTRUMENTS.forEach(g => { INST_ZH[g.v] = g.label; });
      MUSIC_VOCALS.forEach(v => { VOCAL_ZH[v.v] = v.label; });
      function zhList(map, arr) { return (arr || []).map(v => map[v] || v).join("、"); }
      const MODE_ZH = { quick: "快速", standard: "标准", expert: "专家" };
      /* ================= 曲库标准播放器 StudioAudio（2026-11-22 用户批语：播放组件能力显示不全、使用有问题）
       * 裸 <audio controls> 在窄卡/窄列里只渲染出播放·静音·菜单，进度与时长看不见。
       * 能力对齐主流曲库产品：播放/暂停、可点击+拖拽进度条、已播/总长、倍速循环、音量+静音、
       * 加载失败诚实态（占位/坏文件如实标注）、页内单实例互斥（播 A 停 B）。 */
      let AP_ACTIVE = null;   // 页内唯一在播实例
      const StudioAudio = {
        name: "StudioAudio",
        props: {
          src: { type: String, default: "" },
          compact: { type: Boolean, default: false },
          label: { type: String, default: "音频" }
        },
        setup(props) {
          const el = Vue.ref(null);
          const playing = Vue.ref(false);
          const cur = Vue.ref(0);
          const dur = Vue.ref(0);
          const failed = Vue.ref(false);
          const muted = Vue.ref(false);
          const vol = Vue.ref(1);
          const speed = Vue.ref(1);
          const bar = Vue.ref(null);
          const drag = Vue.ref(false);
          const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
          function fmt(t) {
            const n = Math.max(0, Math.floor(Number(t) || 0));
            return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
          }
          const pct = Vue.computed(() => (dur.value ? Math.min(100, (cur.value / dur.value) * 100) : 0));
          function onMeta() { failed.value = false; dur.value = (el.value && el.value.duration) || 0; }
          function onTime() { if (!drag.value) cur.value = el.value ? el.value.currentTime : 0; }
          function onErr() { failed.value = true; playing.value = false; }
          function toggle() {
            const a = el.value;
            if (!a) return;
            if (playing.value) { a.pause(); return; }
            if (AP_ACTIVE && AP_ACTIVE !== a) { try { AP_ACTIVE.pause(); } catch (e) {} }
            AP_ACTIVE = a;
            a.playbackRate = speed.value;
            a.volume = muted.value ? 0 : vol.value;
            const pr = a.play();
            if (pr && pr.catch) pr.catch(() => { failed.value = true; playing.value = false; });
          }
          function seekTo(ev) {
            const a = el.value, box = bar.value;
            if (!a || !box || !dur.value) return;
            const r = box.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
            a.currentTime = ratio * dur.value;
            cur.value = a.currentTime;
          }
          function down(ev) {
            drag.value = true;
            seekTo(ev);
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
          }
          function move(ev) { if (drag.value) seekTo(ev); }
          function up() { drag.value = false; }
          function cycleSpeed() {
            const i = SPEEDS.indexOf(speed.value);
            speed.value = SPEEDS[(i + 1) % SPEEDS.length];
            if (el.value) el.value.playbackRate = speed.value;
          }
          function toggleMute() {
            muted.value = !muted.value;
            if (el.value) el.value.volume = muted.value ? 0 : vol.value;
          }
          function onVol(ev) {
            vol.value = Number(ev.target.value);
            muted.value = vol.value === 0;
            if (el.value) el.value.volume = vol.value;
          }
          Vue.watch(() => props.src, () => {   // 换源复位（卡片复用同组件）
            playing.value = false; cur.value = 0; dur.value = 0; failed.value = false; drag.value = false;
            Vue.nextTick(() => { if (el.value) { try { el.value.load(); } catch (e) {} } });
          });
          return { el, bar, playing, cur, dur, failed, muted, vol, speed, pct, fmt, onMeta, onTime, onErr, toggle, down, move, up, cycleSpeed, toggleMute, onVol };
        },
        template: `
          <div class="v-ap" :class="{'v-ap-c': compact}">
            <audio ref="el" :src="src" preload="metadata" style="display:none" @loadedmetadata="onMeta" @timeupdate="onTime" @ended="playing=false" @error="onErr" @play="playing=true" @pause="playing=false"></audio>
            <div class="v-ap-row">
              <button type="button" class="v-ap-play" @click="toggle" :title="playing ? '暂停' : '播放'">{{ playing ? '⏸' : '▶' }}</button>
              <span class="v-ap-time num">{{ fmt(cur) }}/{{ dur ? fmt(dur) : '--:--' }}</span>
              <span class="grow"></span>
              <button type="button" class="v-ap-ctl" @click="cycleSpeed" :title="'倍速循环（当前 ' + speed + 'x），点击切换'">{{ speed }}x</button>
              <button type="button" class="v-ap-ctl" @click="toggleMute" :title="muted ? '取消静音' : '静音'">{{ muted ? '🔇' : '🔊' }}</button>
              <input v-if="!compact" class="v-ap-vol" type="range" min="0" max="1" step="0.05" :value="vol" @input="onVol" title="音量" />
            </div>
            <div class="v-ap-row v-ap-bar-row">
              <div class="v-ap-bar" ref="bar" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" title="点击或拖动跳转进度">
                <div class="v-ap-fill" :style="{ width: pct + '%' }"></div>
                <div class="v-ap-knob" :style="{ left: pct + '%' }"></div>
              </div>
            </div>
            <div class="v-ap-fail" v-if="failed">⚠ 音频加载失败：占位或坏文件（如实标注，不冒充可用）</div>
          </div>
        `
      };
      /* 候选池溯源：生成要素（中文）＋引擎/节点/时间（用户裁决「得把引擎节点时间显示」） */
      function draftGenLine(d) {
        const g = d.gen;
        if (!g) return "";
        if ((d.domain || d._domain || "music") === "music") {
          const parts = [MODE_ZH[g.mode] || g.mode || ""];
          if (g.genres) parts.push(zhList(GENRE_ZH, String(g.genres).split(/,s*/)));
          if (g.instruments) parts.push(zhList(INST_ZH, String(g.instruments).split(/,s*/)));
          if (g.bpm) parts.push(g.bpm + " BPM");
          if (g.instrumental) parts.push("纯音乐");
          else if (g.vocal) parts.push(VOCAL_ZH[g.vocal] || g.vocal);
          return parts.filter(Boolean).join(" · ");
        }
        const parts = [MODE_ZH[g.mode] || g.mode || ""];
        if (g.size) parts.push(g.size);
        if (g.light) parts.push(g.light);
        return parts.filter(Boolean).join(" · ");
      }
      function draftMetaLine(d) {
        const seg = [];
        if (d.engine) seg.push(String(d.engine));
        if (d.node) seg.push(String(d.node));
        return "⚙ " + ((seg.join(" · ") || "引擎未记录") + " · " + T.fmtTime(d.created_at));
      }

  views.Studio = {
    components: {
      "studio-audio": StudioAudio,
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
        pollTimer = setInterval(async () => {
          pollLeft -= 4;
          tickNow.value = Date.now();
          try { await store.loadStudioDrafts(); store.loadStudioSummary().catch(() => {}); } catch (e) {}
          checkGoing();
          if (pollLeft <= 0) { clearInterval(pollTimer); pollTimer = null; going.music = null; going.images = null; }
        }, 4000);
      }
      function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
      /* 生成中横幅（2026-11-22 用户裁决：生成要有过程感——真机 ≈70s，别让用户以为没结果） */
      const going = Vue.reactive({ music: null, images: null });
      const tickNow = Vue.ref(Date.now());
      function markGoing(domain, note) {
        const cur = (store.studio.drafts && store.studio.drafts[domain]) || [];
        going[domain] = { at: Date.now(), base: cur.length, note };
        tickNow.value = going[domain].at;   // 同步计时基准，防首帧负数
      }
      function checkGoing() {
        ["music", "images"].forEach((k) => {
          if (!going[k]) return;
          const cur = (store.studio.drafts && store.studio.drafts[k]) || [];
          if (cur.length > going[k].base) going[k] = null;   // 候选已回流 → 收横幅
        });
      }
      const genGoing = Vue.computed(() => ["music", "images"].filter(k => going[k]).map(k => {
        const g = going[k];
        const secs = Math.max(0, Math.floor((tickNow.value - g.at) / 1000));
        return { k, text: (k === "music" ? "🎵 音乐" : "🖼 图像") + "生成中（" + g.note + "） · 已等 " + secs + " 秒" };
      }));

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
        ["music", "images", "characters", "scenes", "voices"].forEach(d => store.loadStudioDomain(d));
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
        voiceId: "", cloneMode: "full",   // 声纹克隆（2026-11-22）：克隆条目 id + 生成档位
        structure: "", lyrics: "", caption: "",
        sec: 45, count: 1, projectId: "", _dirtyLyrics: false
      });
      const mBusy = Vue.ref(false);
      const mWarns = Vue.ref([]);
      const preset = Vue.computed(() => MUSIC_TYPE_PRESETS[gMusic.type] || { instrumental: true, structureLine: "", lyrics: "", hint: "" });
      /* 声纹克隆（2026-11-22）：克隆条目列表 + 内联登记表单；选中声纹即切人声通道 */
      const cloneVoices = Vue.computed(() => (lib.value.voices || []).filter(v => v && v.kind === "clone"));
      const selVoice = Vue.computed(() => cloneVoices.value.find(v => v.id === gMusic.voiceId) || null);
      Vue.watch(() => gMusic.voiceId, (id) => { if (id && gMusic.instrumental) gMusic.instrumental = false; });
      const vpShow = Vue.ref(false);
      /* 声纹登记双入口（2026-11-22 用户裁决）：🎤 页面录音为主（MediaRecorder→16k 单声道 WAV），
       * 📁 上传文件降为辅助。录音产物走既有上传链路（服务端 WAV 魔数校验零改动）。 */
      const vpForm = Vue.reactive({ name: "", gender: "女", desc: "", prompt_text: "", consent: false, file: null, busy: false, src: "rec", recOn: false, recSec: 0, recBlob: null, recUrl: "", recErr: "" });
      const vpRecSupported = window.__REC && window.__REC.supported();
      let vpMedia = null, vpRecorder = null, vpChunks = [], vpTimer = null;
      function vpPick(e) {
        vpForm.file = e.target.files[0] || null;
        if (vpForm.file && !vpForm.name) vpForm.name = String((vpForm.file.name || "").replace(/\.[a-z0-9]+$/i, "")).slice(0, 30);
      }
      async function vpRecStart() {
        if (vpForm.recOn || !vpRecSupported) return;
        vpForm.recErr = "";
        try {
          vpMedia = await navigator.mediaDevices.getUserMedia({ audio: true });
          vpChunks = [];
          vpRecorder = new MediaRecorder(vpMedia);
          vpRecorder.ondataavailable = (e) => { if (e.data && e.data.size) vpChunks.push(e.data); };
          vpRecorder.onstop = async () => {
            try {
              (vpMedia && vpMedia.getTracks() || []).forEach((t) => t.stop());
              const raw = new Blob(vpChunks, { type: vpRecorder && vpRecorder.mimeType || "audio/webm" });
              const wav = await window.__REC.blobToWav(raw);
              vpForm.recBlob = wav;
              if (vpForm.recUrl) URL.revokeObjectURL(vpForm.recUrl);
              vpForm.recUrl = URL.createObjectURL(wav);
            } catch (e) {
              vpForm.recErr = "录音转码失败（可换「上传文件」入口）：" + ((e && e.message) || e);
            }
          };
          vpRecorder.start();
          vpForm.recOn = true; vpForm.recSec = 0; vpForm.recBlob = null;
          if (vpForm.recUrl) { URL.revokeObjectURL(vpForm.recUrl); vpForm.recUrl = ""; }
          vpTimer = setInterval(() => {
            vpForm.recSec++;
            if (vpForm.recSec >= 60) vpRecStop();   // 60s 自动停（清唱样本足够）
          }, 1000);
        } catch (e) {
          vpForm.recErr = "无法访问麦克风：" + (e && e.name === "NotAllowedError" ? "权限被拒绝（请在浏览器地址栏允许麦克风后重试）" : ((e && e.message) || e));
        }
      }
      function vpRecStop() {
        if (!vpForm.recOn) return;
        if (vpTimer) { clearInterval(vpTimer); vpTimer = null; }
        vpForm.recOn = false;
        try { if (vpRecorder && vpRecorder.state !== "inactive") vpRecorder.stop(); } catch (e) { /* 忽略 */ }
      }
      function vpRecReset() {
        vpRecStop();
        vpForm.recBlob = null; vpForm.recSec = 0;
        if (vpForm.recUrl) { URL.revokeObjectURL(vpForm.recUrl); vpForm.recUrl = ""; }
      }
      async function vpRegister() {
        if (vpForm.busy || !String(vpForm.name || "").trim() || !vpForm.consent) return;
        const file = vpForm.src === "rec" ? vpForm.recBlob : vpForm.file;
        if (!file) return;
        if (vpForm.src === "rec" && vpForm.recSec < 10) {
          vpForm.recErr = "录音太短（" + vpForm.recSec + "s）——声纹样本建议清唱 20–40 秒"; return;
        }
        vpForm.busy = true;
        try {
          const v = await store.studioCreateVoice(file, { name: vpForm.name.trim(), gender: vpForm.gender, desc: vpForm.desc, prompt_text: vpForm.prompt_text });
          gMusic.voiceId = v.id;
          vpShow.value = false;
          vpForm.name = ""; vpForm.desc = ""; vpForm.prompt_text = ""; vpForm.consent = false; vpForm.file = null;
          vpRecReset();
        } catch (e) { /* toast 已发 */ }
        finally { vpForm.busy = false; }
      }
      async function vpDelete() {
        const v = selVoice.value; if (!v) return;
        const ok = await store.confirm({ title: "删除声纹「" + v.name + "」？（已生成的歌曲不受影响）", okLabel: "确认删除" });
        if (!ok) return;
        try { await store.studioDeleteVoice(v.id); if (gMusic.voiceId === v.id) gMusic.voiceId = ""; } catch (e) {}
      }
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
        if (gMusic.voiceId && !String(gMusic.lyrics || "").trim()) {
          mWarns.value = ["声纹克隆需要歌词（克隆音色演唱自定义歌词）"]; return;
        }
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
            voiceId: gMusic.voiceId || undefined,
            cloneMode: gMusic.voiceId ? gMusic.cloneMode : undefined,
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
          markGoing("music", (MODE_ZH[gMusic.mode] || gMusic.mode) + (gMusic.instrumental ? " · 纯音乐" : " · 人声"));
          startPolling(180);   // 真机音乐 ≈70–120s：轮询窗口必须盖过生成时长（2026-11-22 用户裁决）
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
        size: "远景", light: "", ratio: "9:16", tier: "standard", styleLook: "", refImage: "",
        usage: "ref", editInstruction: "", negativeExtra: "",
        count: 1, projectId: ""
      });
      const iBusy = Vue.ref(false);
      const imgPreset = Vue.computed(() => IMAGE_TYPES.find(t => t.v === gImage.type) || {});
      const iWarns = Vue.ref([]);
      /* 参考图打通（2026-11-22 上传编辑）：上传直填路径＋图库点选；usage=ref（i2i 参考生图）|edit（编辑改图＋指令） */
      async function imgUploadRef(e) {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const entry = await store.studioUpload("images", f, { title: f.name });
          gImage.refImage = entry.art || "";
          gImage.usage = gImage.usage || "ref";
        } catch (err) { /* toast 已发 */ }
        finally { e.target.value = ""; }
      }
      async function genImage() {
        const desc = (gImage.mode === "quick" ? gImage.idea : gImage.desc).trim();
        if (iBusy.value || !desc) return;
        iWarns.value = [];
        const ref = gImage.refImage.trim();
        if (gImage.mode !== "quick" && ref && gImage.usage === "edit" && !String(gImage.editInstruction || "").trim()) {
          iWarns.value = ["编辑改图需要填写编辑指令（要改什么）"]; return;
        }
        iBusy.value = true;
        try {
          const spec = { type: gImage.type, desc, styleLook: gImage.styleLook || undefined, ratio: gImage.ratio, tier: gImage.tier, count: gImage.count, projectId: gImage.projectId || undefined };
          if (gImage.mode !== "quick") {
            spec.size = gImage.size;
            spec.light = gImage.light || undefined;
            spec.refImage = ref || undefined;
            spec.usage = ref ? gImage.usage : undefined;
            spec.editInstruction = (ref && gImage.usage === "edit") ? gImage.editInstruction.trim() : undefined;
          }
          if (gImage.mode === "expert") spec.negativeExtra = gImage.negativeExtra.trim() || undefined;
          await store.studioGenerateImage(spec);
          markGoing("images", (MODE_ZH[gImage.mode] || gImage.mode) + " · " + gImage.count + " 张" + (ref && gImage.usage === "edit" ? " · 编辑改图" : ""));
          startPolling(150);
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
            style: zhList(GENRE_ZH, gMusic.genres) || gMusic.freeTags || "",
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
        IMAGE_TYPES, IMAGE_SIZES, IMAGE_RATIOS, IMAGE_TIERS, IMAGE_LIGHTS, LOOKS, MOODS, SECS,
        tab, goTab, summary, drafts, lib, projects, episodes, srcOf, fmtSec,
        preview, openPreview, closePreview,
        gMusic, mBusy, mWarns, preset, effMood, genMusic, toggleChip, applyPreset, resetPreset, insLyric, markLyricsDirty,
        cloneVoices, selVoice, vpShow, vpForm, vpPick, vpRegister, vpDelete, vpRecSupported, vpRecStart, vpRecStop, vpRecReset,
        assistPaste, assistShow, aiMusicBusy, aiLyrics, aiImgBusy, aiImage,
        gMusic, mBusy, mWarns, preset, effMood, genMusic, toggleChip, applyPreset, resetPreset, insLyric, markLyricsDirty,
        musicFilter, musicList,
        gImage, iBusy, imgPreset, genImage, iWarns, imgUploadRef,
        sceneOptions, bindPick, bindPrimary, bindMusic, unbindMusic, rateMusic, retireMusic, usedBySheet, showUsedBy,
        adoptPick, adoptImage, imgFilter, imageList, rateImage, retireImage,
        upFile, upMeta, doUpload,
        exPick, exRoles, extractChar, promoteFrames, recast,
        gScene, createScene, estVariant, genEstablishing,
        canonLists, gCanon, loadCanon, saveStylePkg, saveRule,
        adoptMusic, discardDraft, draftsAll, draftDomain, genGoing, draftGenLine, draftMetaLine
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
            <!-- 声纹克隆（2026-11-22）：克隆音色演唱自定义歌词；登记样本须勾授权 -->
            <div class="v-studio-fieldrow">
              <span class="field-label">声纹克隆</span>
              <div class="v-studio-chips">
                <select class="select v-studio-sel" v-model="gMusic.voiceId">
                  <option value="">不使用（按人声词典）</option>
                  <option v-for="v in cloneVoices" :key="v.id" :value="v.id">{{ v.name }}（{{ v.gender }}）</option>
                </select>
                <button type="button" class="chip" @click="vpShow = !vpShow">＋ 上传声纹</button>
                <template v-if="selVoice">
                  <studio-audio :src="srcOf(selVoice.ref)" compact style="width:170px" label="声纹样本"></studio-audio>
                  <button type="button" class="chip" @click="vpDelete()">✕ 删除</button>
                  <template v-if="gMusic.mode==='expert'">
                    <button type="button" class="chip" :class="{on: gMusic.cloneMode==='full'}" @click="gMusic.cloneMode='full'" title="两段式：先出完整歌再变声；≈2×耗时，音色贴样本">完整档</button>
                    <button type="button" class="chip" :class="{on: gMusic.cloneMode==='fast'}" @click="gMusic.cloneMode='fast'" title="单段风格迁移：快，但音色较松">快速档</button>
                  </template>
                  <span class="weak" v-else>完整档（两段 · ≈2×耗时）</span>
                </template>
                <span class="weak" v-if="!cloneVoices.length && !vpShow">还没有声纹——上传一段清唱样本（20–40s、无伴奏最佳）</span>
              </div>
            </div>
            <div v-if="vpShow" class="v-music-lyrics v-vp-form">
              <div class="v-music-lyrics-head"><span class="field-label">登记声纹（克隆音色来源）</span>
                <div class="v-studio-chips">
                  <button type="button" class="chip" :class="{on: vpForm.src==='rec'}" @click="vpForm.src='rec'" v-if="vpRecSupported">🎤 页面录音</button>
                  <button type="button" class="chip" :class="{on: vpForm.src==='file'}" @click="vpForm.src='file'">📁 上传文件</button>
                  <span class="weak">{{ vpForm.src==='rec' ? '推荐：按需录一段清唱' : '已有音频文件时使用' }}</span>
                </div>
              </div>
              <div v-if="vpForm.src==='rec'" style="margin:4px 0">
                <div class="v-music-acts" style="margin-top:2px">
                  <button v-if="!vpForm.recOn" type="button" class="btn btn-sm" @click="vpRecStart()">● 开始录音</button>
                  <button v-else type="button" class="btn btn-sm btn-danger" @click="vpRecStop()">■ 停止（{{ vpForm.recSec }}s）</button>
                  <audio v-if="vpForm.recUrl" controls :src="vpForm.recUrl" style="max-width:200px;height:28px" title="录音试听"></audio>
                  <button v-if="vpForm.recUrl" type="button" class="chip" @click="vpRecReset()">↺ 重录</button>
                  <span class="weak">{{ vpForm.recOn ? '录音中…（60 秒自动停）' : '建议清唱 20–40 秒、无伴奏' }}</span>
                </div>
                <div class="weak" v-if="vpForm.recErr" style="color:var(--err,#c0392b)">{{ vpForm.recErr }}</div>
              </div>
              <div class="v-studio-gen">
                <label class="field" v-if="vpForm.src==='file'"><span class="field-label">样本文件（WAV/MP3）</span>
                  <input type="file" accept="audio/*,.wav,.mp3" @change="vpPick" /></label>
                <label class="field"><span class="field-label">名称</span>
                  <input class="input" v-model.trim="vpForm.name" maxlength="30" placeholder="例：阿岚" /></label>
                <label class="field"><span class="field-label">性别</span>
                  <select class="select" v-model="vpForm.gender"><option>女</option><option>男</option></select></label>
                <label class="field" style="grid-column: 1 / -1;"><span class="field-label">音色描述（英文，供变声通道）</span>
                  <input class="input" v-model.trim="vpForm.desc" maxlength="200" placeholder="例：young female vocals, breathy and intimate" /></label>
                <label class="field" style="grid-column: 1 / -1;"><span class="field-label">样本文字稿（可空；预留配音线克隆用）</span>
                  <input class="input" v-model.trim="vpForm.prompt_text" maxlength="200" placeholder="样本里说的那句话（逐字）" /></label>
              </div>
              <div class="v-music-acts" style="margin-top:6px">
                <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" v-model="vpForm.consent" /> 我已获得该声音所有者的授权</label>
                <button type="button" class="btn btn-sm btn-primary" style="white-space:nowrap" :disabled="vpForm.busy || !vpForm.name || !vpForm.consent || (vpForm.src==='rec' ? !vpForm.recBlob : !vpForm.file)" @click="vpRegister()">{{ vpForm.busy ? '登记中…' : '登记声纹' }}</button>
                <span class="weak">样本建议清唱 20–40 秒、无伴奏；登记后即可在本表单选用克隆出歌</span>
              </div>
            </div>
            <div class="v-studio-fieldrow">
              <span class="field-label">曲风</span>
              <div class="v-studio-chips">
                <button v-for="g in MUSIC_GENRES" :key="g.v" type="button" class="chip" :class="{on: gMusic.genres.indexOf(g.v)>=0}" @click="toggleChip(gMusic.genres, g.v)" :title="g.v">{{ g.label }}</button>
              </div>
            </div>
            <div class="v-studio-fieldrow">
              <span class="field-label">乐器</span>
              <div class="v-studio-chips">
                <button v-for="g in MUSIC_INSTRUMENTS" :key="g.v" type="button" class="chip" :class="{on: gMusic.instruments.indexOf(g.v)>=0}" @click="toggleChip(gMusic.instruments, g.v)" :title="g.v">{{ g.label }}</button>
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
            <span class="weak">{{ preset.hint }} · {{ gMusic.voiceId && selVoice ? ('声纹克隆：' + selVoice.name + (gMusic.cloneMode === 'fast' ? ' · 快档' : ' · 完整档')) : (gMusic.instrumental ? '纯音乐' : (gMusic.vocal || '未选人声')) }}</span>
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
                  <td><studio-audio v-if="m.art" :src="srcOf(m.art)" compact style="width:175px" :label="m.title"></studio-audio><span v-else class="weak">无文件</span></td>
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
              <select class="select" v-model="gImage.ratio"><option v-for="r in IMAGE_RATIOS" :key="r.v" :value="r.v">{{ r.label }}</option></select></label>
            <label class="field"><span class="field-label">清晰度</span>
              <select class="select" v-model="gImage.tier"><option v-for="t in IMAGE_TIERS" :key="t.v" :value="t.v">{{ t.label }}</option></select></label>
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
            <!-- 参考图/编辑改图（2026-11-22 上传编辑）：上传直填＋图库点选＋用法二选一 -->
            <div class="v-studio-fieldrow" style="margin-top:8px">
              <span class="field-label">参考图</span>
              <div class="v-studio-chips">
                <input class="input" v-model.trim="gImage.refImage" maxlength="200" placeholder="库内路径 var/assets/library/images/…（可手填）" style="max-width:330px" />
                <label class="chip" style="cursor:pointer">⬆ 上传图片<input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" style="display:none" @change="imgUploadRef" /></label>
                <select class="select v-studio-sel" v-model="gImage.refImage">
                  <option value="">从图库选…</option>
                  <option v-for="m in imageList.slice(0, 30)" :key="m.id" :value="m.art">{{ (m.title || m.desc || '图').slice(0, 16) }}</option>
                </select>
                <button type="button" class="chip" v-if="gImage.refImage" @click="gImage.refImage = ''; gImage.usage = 'ref'">✕ 清除</button>
              </div>
            </div>
            <div class="v-studio-fieldrow" v-if="gImage.refImage">
              <span class="field-label">用法</span>
              <div class="v-studio-chips">
                <button type="button" class="chip" :class="{on: gImage.usage==='ref'}" @click="gImage.usage='ref'" title="以参考图为基准重绘（保影调变构图）">参考生图</button>
                <button type="button" class="chip" :class="{on: gImage.usage==='edit'}" @click="gImage.usage='edit'" title="编辑模型保真改图：只改指令要求的部分">编辑改图</button>
                <span class="weak" v-if="gImage.usage==='ref'">i2i 参考生图 · 保影调</span>
                <span class="weak" v-else>编辑模型 · 保真改图（≈1 分钟/张）</span>
              </div>
            </div>
            <label class="field" v-if="gImage.refImage && gImage.usage==='edit'" style="width:100%;margin-top:4px"><span class="field-label">编辑指令（必填——要改什么，例如「把背景换成雨夜码头，人物不动」）</span>
              <input class="input" v-model.trim="gImage.editInstruction" maxlength="400" placeholder="例：把背景换成雨夜码头，人物姿势不动" /></label>
            <div class="v-studio-gen" style="margin-top:4px;">
              <label class="field" v-if="gImage.mode==='expert'" style="grid-column:1/3"><span class="field-label">负面增补（可空，逗号分隔）</span>
                <input class="input" v-model.trim="gImage.negativeExtra" maxlength="200" placeholder="例：文字, 水印, 多人" /></label>
            </div>
          </div>

          <div class="v-music-acts">
            <button type="button" class="chip chip-ai" :disabled="aiImgBusy" @click="aiImage()" :title="gImage.mode==='quick' ? '把一句话想法按四层规范扩写成专业描述' : '把当前描述按四层规范润色扩写'">
              {{ aiImgBusy ? 'AI 写画面中…' : '✨ AI 写画面' }}</button>
            <button class="btn btn-primary" :disabled="iBusy || !(gImage.mode==='quick' ? gImage.idea.trim() : gImage.desc.trim())" @click="genImage">{{ iBusy ? '排队中…' : '生成候选（' + gImage.count + ' 张）' }}</button>
            <span class="weak">{{ imgPreset.hint }}{{ gImage.tier !== 'standard' ? ' · ' + (IMAGE_TIERS.find(t => t.v === gImage.tier) || {}).label + '（本机线超档自动回落）' : '' }}</span>
          </div>
          <div class="v-music-warns" v-if="iWarns.length">
            <div v-for="(w,i) in iWarns" :key="i">⚠ {{ w }}</div>
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
          <div v-if="genGoing.length" style="margin:6px 0 10px;padding:8px 12px;border:1px dashed #33507e;border-radius:8px;background:rgba(51,80,126,.12)">
            <div v-for="g in genGoing" :key="g.k" style="color:#9fc2ff">⏳ {{ g.text }}——真机生成约 1–2 分钟，完成后自动出现在下方</div>
          </div>
          <empty-state v-if="!draftsAll.length" icon="📥" text="候选池是空的" sub="去「音频」或「图像」生成一批。"></empty-state>
                      <div class="v-studio-drafts" v-else>
              <div class="card v-studio-draft" :class="{'v-studio-draft-music': draftDomain(d)==='music'}" v-for="d in draftsAll" :key="draftDomain(d)+d.id">
                <div class="v-studio-draft-media">
                  <template v-if="draftDomain(d)==='music'">
                    <studio-audio v-if="d.art" :src="srcOf(d.art)" style="width:100%" :label="d.title"></studio-audio>
                    <span v-else class="weak">生成中…</span>
                  </template>
                  <template v-else>
                    <img v-if="d.art" :src="srcOf(d.art)" loading="lazy" style="cursor:zoom-in" alt="" title="点击放大预览" @click="openPreview(d.art, d.title || d.desc)" />
                    <span v-else class="weak">生成中…</span>
                  </template>
                </div>
                <div class="v-studio-draft-body">
                  <div class="row">
                    <b class="grow">{{ d.title }}</b>
                    <span class="badge">{{ draftDomain(d)==='music' ? '音频' : '图像' }}</span>
                  </div>
                  <div class="weak" v-if="d.mood">{{ d.mood }} · {{ fmtSec(d.sec) }}</div>
                  <div class="weak" v-if="d.tags">引擎 tags（模型英文词汇）：{{ d.tags }}</div>
                  <div class="weak" v-if="draftGenLine(d)" style="color:#9fc2ff">要素：{{ draftGenLine(d) }}</div>
                  <div class="weak" v-if="draftDomain(d)==='music' && d.caption">描述：{{ d.caption }}</div>
                  <div class="weak">{{ draftMetaLine(d) }}</div>
                  <div class="weak v-studio-draft-desc" v-if="d.desc">{{ d.desc }}</div>
                  <div class="row" style="margin-top:4px"><license-badge v-if="d.license" :license="d.license"></license-badge><money v-if="d.shadow_cents" :cents="d.shadow_cents"></money></div>
                  <div class="v-studio-draft-acts">
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
                  </div>
                </div>
              </div>
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
