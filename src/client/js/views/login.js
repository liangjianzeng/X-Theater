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
      async function submit() {
        if (!ref.value || busy.value) return;
        busy.value = true; err.value = null;
        try {
          await T.store.login(ref.value);
          global.__ROUTER.go("#/home");
        } catch (e) { err.value = e; }
        finally { busy.value = false; }
      }
      return { code: ref, busy, err, submit };
    }
  };
})(window);
