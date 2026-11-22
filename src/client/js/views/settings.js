/* 剧场 Studio · 设置视图（视图 C 负责）
   #/settings：当前身份卡＋域（主账户）切换/建域/成员管理（S3-8）＋制片助手运行模式＋退出登录。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const ROLE_CN = { owner: "域主", admin: "管理员", member: "成员", viewer: "只读", platform: "平台运营" };

  views.Settings = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money
    },
    setup() {
      const L = store.l2;
      const user = Vue.computed(() => store.auth.user);
      const roleTxt = Vue.computed(() => {
        const r = user.value && user.value.role;
        return r === "ops" ? "运营" : r === "creator" ? "创作者" : T.sanitize(r || "—");
      });
      const roleCls = Vue.computed(() => (user.value && user.value.role === "ops" ? "badge-ok" : ""));

      /* ---------- 域（主账户）：切换 / 建域 / 成员管理（S3-8） ---------- */
      const tenants = Vue.computed(() => store.tenant.list || []);
      const tenantsLoading = Vue.computed(() => store.tenant.loading);
      const curTid = Vue.computed(() => store.tenant.current);
      const switching = Vue.ref(false);
      const pjForm = Vue.reactive({ name: "", busy: false });
      const mgTid = Vue.ref(null); // 正在展开管理的域
      const mg = Vue.reactive({ loading: false, detail: null });
      const mgForm = Vue.reactive({ name: "", domainRole: "member" });
      const mgBudget = Vue.ref(""); // 域预算输入（分；空＝无上限）
      const mgBilling = Vue.ref(null); // 域计费聚合

      Vue.onMounted(() => { store.loadTenants().catch(() => {}); });

      async function switchTo(t) {
        if (switching.value || t.id === curTid.value) return;
        switching.value = true;
        try { await store.switchTenant(t.id); } catch (e) { /* store 已 toast */ }
        finally { switching.value = false; }
      }
      async function createTenant() {
        const name = String(pjForm.name || "").trim();
        if (!name) { store.toast("给域起个名字（团队/频道名）", "warn"); return; }
        pjForm.busy = true;
        try {
          const t = await store.createTenant(name);
          pjForm.name = "";
          await store.switchTenant(t && t.id); // 建完直接切过去
        } catch (e) { /* store 已 toast */ }
        finally { pjForm.busy = false; }
      }
      async function openManage(t) {
        if (mgTid.value === t.id) { mgTid.value = null; mg.detail = null; mgBilling.value = null; return; }
        mgTid.value = t.id;
        mg.loading = true; mg.detail = null; mgBilling.value = null;
        try {
          mg.detail = await store.loadTenantDetail(t.id);
          mgBudget.value = mg.detail.tenant && mg.detail.tenant.budget_cents != null ? String(mg.detail.tenant.budget_cents) : "";
          store.loadTenantBilling(t.id).then(b => { mgBilling.value = b; }).catch(() => {});
        } catch (e) { mgTid.value = null; }
        finally { mg.loading = false; }
      }
      async function reloadManage(t) {
        try {
          mg.detail = await store.loadTenantDetail(t.id);
          store.loadTenantBilling(t.id).then(b => { mgBilling.value = b; }).catch(() => {});
        } catch (e) { /* store 已 toast */ }
      }
      async function genInvite(t) {
        const name = String(mgForm.name || "").trim();
        if (!name) { store.toast("给新成员起个名字", "warn"); return; }
        try {
          await store.addTenantInvite(t.id, name, mgForm.domainRole);
          mgForm.name = "";
          await reloadManage(t);
        } catch (e) { /* store 已 toast */ }
      }
      async function revokeInvite(t, iv) {
        const r = await store.removeTenantInvite(t.id, iv.code);
        if (r) await reloadManage(t);
      }
      async function saveBudget(t) {
        const raw = String(mgBudget.value).trim();
        const cents = raw === "" ? null : Math.round(Number(raw));
        if (raw !== "" && (!Number.isFinite(cents) || cents < 0)) {
          store.toast("预算须为 ≥0 的整数（单位分），留空＝无上限", "warn"); return;
        }
        try {
          await store.setTenantBudget(t.id, cents);
          await reloadManage(t);
        } catch (e) { /* store 已 toast */ }
      }
      async function changeRole(t, m, role) {
        try { await store.setTenantMemberRole(t.id, m.uid, role); await reloadManage(t); }
        catch (e) { /* store 已 toast */ }
      }
      async function doTransfer(t, m) {
        const r = await store.transferTenant(t.id, m.uid);
        if (r) { await reloadManage(t); store.loadTenants().catch(() => {}); }
      }
      async function kickMember(t, m) {
        const ok = await store.confirm({
          title: "把「" + (m.name || m.uid) + "」移出「" + t.name + "」？",
          html: "移出后 TA 在本域的登录仍有效（账号保留），但看不到本域任何项目与剧集。",
          okLabel: "移出"
        });
        if (!ok) return;
        try {
          await store.removeTenantMember(t.id, m.uid);
          await reloadManage(t);
        } catch (e) { /* store 已 toast */ }
      }
      function roleCn(r) { return ROLE_CN[r] || T.sanitize(r || "—"); }
      function myDomainRole(t) {
        const d = mg.detail;
        const me = store.auth.user && store.auth.user.id;
        const m = d && (d.members || []).find(x => x.uid === me);
        return m ? m.role : (t.role === "platform" ? "platform" : null);
      }

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

      return {
        store, L, user, roleTxt, roleCls,
        tenants, tenantsLoading, curTid, switching, pjForm,
        mgTid, mg, mgForm, mgBudget, mgBilling,
        switchTo, createTenant, openManage, genInvite, kickMember, roleCn, myDomainRole,
        revokeInvite, saveBudget, changeRole, doTransfer,
        mode, busy, statusBadge, curModeTxt, reconnect, logout
      };
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

        <!-- 域（主账户）：切换 / 建域 / 成员管理（S3-8） -->
        <div class="panel">
          <div class="panel-title">🌐 域（主账户）
            <span class="badge badge-ok" v-if="store.tenant.currentName">{{ store.tenant.currentName }}</span>
            <span class="weak">域内项目/剧集互相隔离，随时切换</span>
          </div>
          <loading v-if="tenantsLoading && !tenants.length"></loading>
          <div class="list" v-else-if="tenants.length">
            <div class="list-item" v-for="t in tenants" :key="t.id">
              <div class="row wrap">
                <b>{{ t.name }}</b>
                <span class="badge" :class="t.id === curTid ? 'badge-ok' : ''">
                  {{ t.id === curTid ? '当前' : roleCn(t.role) }}</span>
                <span class="badge" v-if="t.id !== curTid && t.id === curTid"></span>
                <span class="grow"></span>
                <button class="btn btn-sm" v-if="t.id !== curTid" :disabled="switching" @click="switchTo(t)">
                  {{ switching ? '切换中…' : '切换' }}</button>
                <button class="btn btn-sm btn-ghost" v-if="t.role === 'owner' || t.role === 'admin' || t.role === 'platform'"
                  @click="openManage(t)">{{ mgTid === t.id ? '收起管理' : '成员管理' }}</button>
              </div>
              <div v-if="mgTid === t.id" style="margin-top:8px">
                <loading v-if="mg.loading"></loading>
                <template v-else-if="mg.detail">
                  <!-- 域预算与成本（P2） -->
                  <div class="row wrap" style="margin:4px 0 8px">
                    <span class="weak">域预算（分，空＝无上限）</span>
                    <input class="input num" style="max-width:120px" v-model.trim="mgBudget" placeholder="如 50000" />
                    <button class="btn btn-sm" @click="saveBudget(t)">保存</button>
                    <span v-if="mgBilling" class="weak">
                      已用 <money :cents="mgBilling.total_cents || 0"></money>
                      <span v-if="mgBilling.pct != null">（{{ mgBilling.pct }}%）</span>
                    </span>
                  </div>
                  <div v-if="mgBilling && mgBilling.by_episode && mgBilling.by_episode.length" class="weak" style="margin-bottom:8px">
                    花费最高：
                    <span v-for="(e, i) in mgBilling.by_episode.slice(0, 3)" :key="e.episodeId">
                      {{ i ? ' · ' : '' }}{{ e.title }} <money :cents="e.cents"></money>
                    </span>
                  </div>

                  <div class="weak" style="margin:4px 0">成员 {{ (mg.detail.members || []).length }} 人 · 我的身份：{{ roleCn(myDomainRole(t)) }}</div>
                  <div class="table-scroll">
                    <table class="table">
                      <thead><tr><th>成员</th><th>域内身份</th><th></th></tr></thead>
                      <tbody>
                        <tr v-for="m in mg.detail.members" :key="m.uid">
                          <td><b>{{ m.name }}</b> <span class="badge" v-if="m.platform_role === 'ops'">运营</span></td>
                          <td>{{ roleCn(m.role) }}</td>
                          <td>
                            <template v-if="m.role !== 'owner'">
                              <select class="select" style="max-width:110px" :value="m.role"
                                @change="changeRole(t, m, $event.target.value)">
                                <option value="admin">管理员</option>
                                <option value="member">成员</option>
                                <option value="viewer">只读</option>
                              </select>
                              <button class="btn btn-sm" v-if="myDomainRole(t) === 'owner' || myDomainRole(t) === 'platform'"
                                @click="doTransfer(t, m)">转让域主</button>
                              <button class="btn btn-sm btn-danger" @click="kickMember(t, m)">移出</button>
                            </template>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div class="row wrap" style="margin-top:8px">
                    <input class="input" style="max-width:160px" v-model.trim="mgForm.name" placeholder="新成员名" />
                    <select class="select" style="max-width:150px" v-model="mgForm.domainRole">
                      <option value="member">成员（读写）</option>
                      <option value="admin">管理员（须域主）</option>
                      <option value="viewer">只读审片</option>
                    </select>
                    <button class="btn btn-primary btn-sm" @click="genInvite(t)">生成域邀请码</button>
                  </div>
                  <div class="card" v-if="mg.detail.invites && mg.detail.invites.length" style="margin-top:8px">
                    <div class="weak" style="margin-bottom:4px">本域邀请码</div>
                    <div class="list-item row wrap" v-for="iv in mg.detail.invites" :key="iv.code">
                      <b class="mono">{{ iv.code }}</b>
                      <span class="weak">{{ iv.name || '' }}</span>
                      <span class="badge">{{ roleCn(iv.domain_role || 'member') }}</span>
                      <span class="badge" :class="iv.used ? 'badge-ok' : ''">{{ iv.used ? '已绑定' : '未使用' }}</span>
                      <span class="grow"></span>
                      <button class="btn btn-sm btn-danger" @click="revokeInvite(t, iv)">吊销</button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
          <empty-state v-else icon="🌐" text="还没有域" sub="建一个域，把项目和剧集装进去"></empty-state>
          <form class="row wrap" style="margin-top:10px" @submit.prevent="createTenant">
            <input class="input" style="max-width:220px" v-model.trim="pjForm.name" placeholder="新域名（例：XX 工作室）" />
            <button class="btn btn-primary" type="submit" :disabled="pjForm.busy" :aria-busy="pjForm.busy">
              {{ pjForm.busy ? '创建中…' : '＋ 新建域' }}</button>
            <span class="weak">你将成为该域的域主</span>
          </form>
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
