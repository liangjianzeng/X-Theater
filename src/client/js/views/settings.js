/* 剧场 Studio · 设置视图（视图 C 负责）
   #/settings：当前身份卡＋制片助手运行模式（A 云端托管 / B 本机内置，重连=store.l2Create）＋退出登录。
   后端没有成员/分享端点，这里不提供任何相关入口。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  views.Settings = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading
    },
    setup() {
      const L = store.l2;
      const user = Vue.computed(() => store.auth.user);
      const roleTxt = Vue.computed(() => {
        const r = user.value && user.value.role;
        return r === "ops" ? "运营" : r === "creator" ? "创作者" : T.sanitize(r || "—");
      });
      const roleCls = Vue.computed(() => (user.value && user.value.role === "ops" ? "badge-ok" : ""));

      /* ---------- 运行模式 ---------- */
      const mode = Vue.ref(String(L.mode || "A") === "B" ? "B" : "A");
      const busy = Vue.ref(false);
      Vue.watch(() => L.mode, m => { if (m) mode.value = String(m) === "B" ? "B" : "A"; });

      const statusBadge = Vue.computed(() => {
        if (L.status === "ready" && L.sid) return { cls: "badge-ok", txt: "助手已连接" };
        if (L.status === "broken") return { cls: "badge-err", txt: "助手连接失败" };
        return { cls: "", txt: "未连接" };
      });
      const curModeTxt = Vue.computed(() =>
        L.sid ? (String(L.mode) === "B" ? "当前 B · 本机内置" : "当前 A · 云端托管") : "尚未连接"
      );

      async function reconnect() {
        if (busy.value) return;
        busy.value = true;
        try {
          await store.l2Create(mode.value);
          store.toast("制片助手已按模式 " + mode.value + " 重新接上", "ok");
        } catch (e) { /* ErrState 负责呈现，store.l2.status 已置 broken */ }
        finally { busy.value = false; }
      }

      /* ---------- 退出 ---------- */
      async function logout() {
        const ok = await store.confirm({
          title: "退出登录？",
          summary: "退出后需要凭邀请码重新进门，未完成的动作不受影响。",
          okLabel: "退出"
        });
        if (ok) store.logout();
      }

      return { store, L, user, roleTxt, roleCls, mode, busy, statusBadge, curModeTxt, reconnect, logout };
    },
    template: `
      <div class="v-settings">

        <div class="panel">
          <div class="panel-title">当前身份</div>
          <div class="kv" v-if="user">
            <div class="kv-row"><span class="weak">名字</span><b>{{ user.name }}</b></div>
            <div class="kv-row"><span class="weak">角色</span><span class="badge" :class="roleCls">{{ roleTxt }}</span></div>
            <div class="kv-row"><span class="weak">编号</span><span class="mono">{{ user.id }}</span></div>
          </div>
          <empty-state v-else icon="👤" text="身份信息还没载入" sub="刷新一下页面试试。"></empty-state>
        </div>

        <div class="panel">
          <div class="panel-title">
            制片助手运行模式
            <span class="badge" :class="statusBadge.cls">{{ statusBadge.txt }}</span>
            <span class="weak">{{ curModeTxt }}</span>
          </div>
          <div class="row wrap v-settings-modes">
            <label class="list-item v-settings-opt" :class="{ active: mode === 'A' }">
              <span class="row"><input type="radio" value="A" v-model="mode" /><b>模式 A · 云端托管</b></span>
              <span class="weak">助手实例跑在托管环境，开机即用，适合大多数创作。</span>
            </label>
            <label class="list-item v-settings-opt" :class="{ active: mode === 'B' }">
              <span class="row"><input type="radio" value="B" v-model="mode" /><b>模式 B · 本机内置</b></span>
              <span class="weak">助手实例跑在本机内置运行时，动作不出本机。</span>
            </label>
          </div>
          <div class="row" style="margin-top:12px;">
            <button class="btn btn-primary" :disabled="busy" :aria-busy="busy" @click="reconnect">
              {{ busy ? '重连中…' : '重连助手' }}
            </button>
            <loading v-if="busy"></loading>
          </div>
          <err-state v-if="L.status === 'broken' && L.error" :err="L.error" :on-retry="reconnect" compact></err-state>
        </div>

        <div class="panel">
          <div class="panel-title">账号</div>
          <div class="row">
            <button class="btn btn-danger" @click="logout">退出登录</button>
            <span class="weak">退出后本机会清掉凭据。</span>
          </div>
        </div>
      </div>`
  };
})(window);
