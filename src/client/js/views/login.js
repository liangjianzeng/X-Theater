/* 剧场 Studio · 登录视图（骨架文件） */
(function (global) {
  "use strict";
  const T = global.__T;
  const views = (global.__VIEWS = global.__VIEWS || {});

  views.Login = {
    template: `
      <div class="login-wrap">
        <form class="login-card card" @submit.prevent="submit">
          <div class="brand"><span class="brand-mark">剧</span><div><b>剧场 Studio</b><div class="weak">AI 短剧 · 全自部署创作系统</div></div></div>
          <label class="field">
            <span class="field-label">内测邀请码</span>
            <input class="input" v-model.trim="code" placeholder="向运营索取邀请码" autocomplete="off" />
          </label>
          <div v-if="hint" class="weak login-hint" @click.prevent="fillHint" title="点击填入">
            演示环境邀请码：<b>{{ hint }}</b>（点击填入）
          </div>
          <err-state v-if="err" :err="err" :on-retry="() => { err = null; }" compact></err-state>
          <button class="btn btn-primary" type="submit" :disabled="busy || !code">
            {{ busy ? '进门中…' : '进门' }}
          </button>
          <div class="weak login-foot">邀请制 · 登录即代表同意创作内容安全审计与影子计费记账</div>
        </form>
      </div>`,
    components: { "err-state": T.components.ErrState },
    setup() {
      const ref = global.Vue.ref("");
      const busy = global.Vue.ref(false);
      const err = global.Vue.ref(null);
      // 演示邀请码提示：仅当服务端邀请码仍是出厂种子时返回（运营自定义后立即静默）
      const hint = global.Vue.ref("");
      T.api.get("/login/hint").then((r) => { hint.value = (r && r.code) || ""; }).catch(() => {});
      function fillHint() { if (hint.value) ref.value = hint.value; }
      async function submit() {
        if (!ref.value || busy.value) return;
        busy.value = true; err.value = null;
        try {
          await T.store.login(ref.value);
          global.__ROUTER.go("#/home");
        } catch (e) { err.value = e; }
        finally { busy.value = false; }
      }
      return { code: ref, busy, err, submit, hint, fillHint };
    }
  };
})(window);
