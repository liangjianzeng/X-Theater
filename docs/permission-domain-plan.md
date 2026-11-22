# 权限域（多租户）重构方案 — 调研分析与建议

> 2026-11-22 · 目标：主账户（域）之间相互隔离，域内子账户共享资源；给出契合本项目
> 零依赖单文件架构的分阶段落地路径。现状盘点与行业方案均基于代码实证＋公开资料。

## 0. 一句话结论

**采用「pool 模式的应用层等价物」：全域数据加 `tenantId`，在唯一的读取/写入入口做投影与归属校验，token 携带 `{uid, tid, role}`；不做 schema/DB 级隔离（与单文件架构冲突）。** 分四期落地，Phase 0/1 是地基且成本低（约 3-4 人日），Phase 2/3 视商业化节奏。

## 1. 现状盘点（代码级漏水点）

| # | 漏水点 | 位置 | 后果 |
|---|--------|------|------|
| 1 | 邀请码映射到既有 ops 账号，多人共用一个 uid | `api/auth.js:33-45` | 两人登录＝同一身份，审计无法区分人 |
| 2 | projects/episodes 无 owner / tenantId 字段 | `api/projects.js:34`、`api/episodes.js:113` | 无归属语义，谈不上隔离 |
| 3 | `GET /api/state` 对任何登录用户返回全量数据 | `api/state.js` | A 域的集/卡/成本 B 全看得到 |
| 4 | SSE 全 topic 广播，无订阅端过滤 | `api/events.js:35`（`bus.attach(res)` 无谓词） | 别人域的任务/卡片事件实时推给你 |
| 5 | `/var/out/*`、`/var/assets/*` 静态资源**无鉴权**直读 | `index.js:176+` serveStatic | 拿到 URL 即可读任意成片/定妆图（跨域泄露） |
| 6 | token 校验兜底**信任 payload.role** | `index.js:129-132`（users 里查不到人时用 token 里的 role 造用户） | 被删账号的旧 token 仍按旧角色放行 |
| 7 | 卡片 `decided_by` 恒 null | `api/cards.js:958` | 拍板无法归责 |
| 8 | job/账本行无租户维度 | `dag/engine.js` logJob | 成本无法按域聚合计费 |

另有结构性事实：单一 `var/state.json`（`core/store.js`），所有 handler 直接 `store.get()` 拿全局可变对象——**任何"靠每个端点自觉过滤"的方案都注定漏**，必须在入口集中强制。

## 2. 行业方案调研

### 2.1 数据隔离三模式（AWS 分类：silo / bridge / pool）

| 模式 | 做法 | 优点 | 代价 | 适用 |
|------|------|------|------|------|
| **silo**（库级） | 一租户一数据库 | 最强隔离、合规友好 | 成本/运维最高，跨租户统计难 | 大客户/合规要求 |
| **bridge**（schema 级） | 一租户一 schema | 中等隔离、易按租户备份/定制 | 迁移 O(N 租户) | 中型 B2B |
| **pool**（行级） | 共享表＋`tenant_id`＋**RLS 强制** | 最便宜、跨租户统计容易 | 必须有 DB 层强制（防漏 WHERE） | 绝大多数 SaaS 的起点 |

共识（AWS/multi-tenant 资料）：**从 pool 起步，RLS 把租户上下文做成会话变量（如 `app.current_tenant`）在数据库层强制**，应用层漏写 WHERE 也不会泄露；`tenant_id` 必须进索引。

**映射到本项目**：没有 DB/RLS 可用（零依赖单 JSON 文件），pool 模式的等价物＝
① 全域实体带 `tenantId`；② **唯一的读取入口做投影**（等价 RLS 的会话变量）；③ 引擎/账本/静态资源同步带租户维度。silo 的对应物其实已经存在——"一套部署一个 var/"（一期自部署形态）本身就是实例级 silo，无需改代码。

### 2.2 组织与角色模型（GitHub/Notion/Slack/Figma 通例）

- 层级：**域（org/workspace）→ 群组/团队 → 资源（repo/页面/文件）**，角色沿层级继承。
- 角色通例：**Owner → Admin → Member（→ Viewer/Guest）**，角色**按域作用域**（同一个人在不同域可以是不同角色），GitHub 另有 repo 级覆写。
- Auth0 Organizations / Clerk / WorkOS 的 B2B 标准做法：**org ID ＋ org-scoped roles 作为 token claims**，授权服务按 claim 裁决；权限先按"应用动作"建模再命名角色。

### 2.3 AI 视频 SaaS 产品面（Runway / HeyGen）

- **Runway Team**：2-9 席位、按席位计费（$69/席/月），成员 Admin/Editor 角色，各席 credits **汇成一个团队共享池**。
- **HeyGen**：基础套餐＋加购席位（$149 首席＋$20/席），workspace 共享视频资产，成员分 Creator/Viewer 角色，集中计费。
- 共性：**域＝计费与配额边界**（credits/预算池在域级），席位内共享资产，域外互不可见。

### 2.4 对本项目的启示

1. 行业默认答案就是用户直觉的方案：**主账户＝域（tenant），子账户＝域成员，域内共享、域间隔离**；成本/配额在域级聚合（本项目的 `budget_cents`/billing 天然要长到域上）。
2. 粒度上本项目只需要 **org RBAC**（3-4 个固定角色），不需要 ABAC/策略引擎（Cerbos 类）——留扩展点即可，别上重炮。
3. token 带 `{uid, tid, role}` 三元组是行业标准（Auth0 Organizations 同款），换域＝换 token。

## 3. 建议方案（分四期）

### 设计原则

- **服务端强制，前端过滤只是体验**——投影/归属校验必须在服务端唯一入口。
- **零新依赖**：不用 JWT 库/策略引擎，沿用 `util.sign` 自签 token，扩展 payload。
- **向后兼容**：老 token（无 tid）→ 视为落在默认域，7 天 TTL 自然淘汰。
- **迁移一次性**：首次启动检测 `state.tenants` 缺失 → 建「默认工作台」域，把存量 projects/episodes 全部归入，owner = 现有 ops 账号。

### Phase 0 — 身份地基（约 1 人日）

1. **邀请码按人发**：`state.invites` 从 `[code]` 升级为 `{code → {name, role, uid?}}`；登录各建各号（`auth.js` 登录语义改造）。老种子码 `INV-DEMO-1` 保留映射到 u2。
2. **归责补全**：卡片拍板写 `decided_by: auth.uid`（cards.js decide 路径）；审计已带 operator，账本行加 `operator`。
3. **堵 token fallback**：users 里查不到的 uid → 直接 401（去掉 `index.js:129-132` 对 payload.role 的信任）。

### Phase 1 — 域（主账户）核心（约 2-3 人日）★ 本方案主体

**数据模型**（`core/store.js` 种子迁移）：

```
state.tenants = {
  tid_01: {
    id, name: "XX 工作室", owner_uid: "u2",
    members: { uid → role }        // role: owner|admin|member|viewer
    invites: ["INV-XXX"],
    budget_cents: 50000            // 域级预算池（Phase 2 启用护栏）
  }
}
projects[i].tenantId / episodes[i].tenantId / l2_sessions[sid].tenantId
```

**token**：`{uid, tid, role, exp}`；新增 `POST /api/auth/switch {tid}` 校验成员身份后重签。

**唯一投影入口（本方案的心脏）**：router 层新增 `ctx.scope(st, auth)` ——返回「当前域视图」：
```js
// core/router.js 或 api/_scope.js：所有域敏感 handler 一律
const view = ctx.scope(store.get(), auth);   // {tenant, projects, episodes, canWrite}
```
- `role==="ops"`（平台运营）→ 全量；否则按成员关系过滤。
- 写操作加 `assertInTenant(res, auth)`（ep/projects 归属校验，非本域 → 404/403，**404 优先**——不向域外用户确认资源存在）。
- 改造点集中：`state.js`（投影）、`projects.js/episodes.js/cards.js`（create 时 stamp tenantId + 归属校验）、`l2/governance.js`（域内预算）。

**事件流**：`core/bus.js` `attach(res, {tid})` 订阅端按谓词过滤（publish 侧消息已带 episodeId/projectId → 可反查 tid；jobs stamp tid 后免反查）。

**引擎与账本**：`engine.enqueue` opts 带 `tid` → job 对象、`log-job/billing` 账本行都带；成本按域聚合成为可能（`GET /api/tenants/:tid/billing`，Phase 2 开放 UI）。

**静态资产堵漏**：`/var/out/*`、`/var/assets/*` 从裸静态改为**登录墙**（token 校验，index.js serveStatic 前置 authFn）——先做到「不登录不可读」；域级文件 ACL（资产→租户索引反查）放 Phase 2，因为现有 `art` 引用都在 state 里可反查，但需要建索引与缓存。

**前端**：顶栏域切换器（多域用户）＋ 域成员管理页（owner/admin 可见）；`store.refreshState` 天然跟随服务端投影，无需大改。

### Phase 2 — 域内 RBAC ＋ 配额（约 2 人日）

- 角色矩阵落地：owner（转让/删域）、admin（成员/模板）、member（创作全链）、viewer（只读＋审片）。
- **域级预算护栏**：engine `guardrail()` 增加 per-tenant 检查（现有 per-episode 120% 机制同款），超限自动暂停域内派单＋告警。
- 成员席位管理 UI、邀请码生成/吊销（owner/admin）。
- 资产域级 ACL（art 引用反查索引）。

### Phase 3 — 跨域共享（按需）

- 模板库本就是全局运营配置（`api/templates.js`），天然跨域共享，无需动。
- 分享链接：signed URL（`sign({art, tid, exp})`）＋ TTL，供审片/交付外发。
- 资产市场/跨域协作（引用而非拷贝）。

### 明确不做（与理由）

| 方案 | 理由 |
|------|------|
| schema/DB-per-tenant（进程内 bridge/silo） | 与零依赖单文件架构冲突；规模不匹配；跨域统计反而变难 |
| 每租户独立 var/ 目录（文件级 silo 变体） | state.json 是单文件，拆目录等于拆实例；真要 silo 就直接**一套部署一个实例**（现状自部署形态即天然 silo，企业/合规档走这条路，不改代码） |
| 纯前端按用户过滤 | 服务端仍返回全量＝裸奔；只可作为体验优化叠加 |
| ABAC/外部策略引擎（Cerbos/OPA） | 当前粒度只需 org RBAC；等出现"按标签/按镜头授权"需求再议 |

## 4. 产品分叉提示（决定投入节奏）

- **形态 A：一客户一套部署**（一期自部署现状）→ 实例级隔离天然存在。Phase 0/1 依然值得做（多人协作体验＋归责），Phase 2/3 缓行。
- **形态 B：一台部署服务多个主账户**（SaaS / 一套部署多 MCN 团队）→ Phase 1 是必经之路，且域级计费（Phase 2）承接 Runway/HeyGen 式"席位＋共享 credits 池"的商业模式。

两形态共享同一份代码路径（pool 模式），迁移成本递增而非重写。

## 5. 风险与备注

- `bus.js` 目前 attach 无谓词，需验证 publish 消息体里 episodeId→tid 反查的时机（episode 删除后的事件会查不到，退化为丢弃——可接受）。
- 投影层务必覆盖 `l2_sessions`（副驾会话含全量剧本上下文）与 `music_lib`（版权按域）。
- 存量回填只跑一次：用 `state.tenants` 存在性做迁移标记，避免每次启动重灌。
- 参考实现顺序建议：Phase 0 → Phase 1 的 scope 投影＋state.js（先只读隔离）→ 写侧归属校验 → SSE → 资产登录墙 → 前端切换器。

## 6. 落地状态（2026-11-22 更新）

**Phase 0/1/2 已全部落地上线**（8767 真机运行）。实际实现与方案的差异与增量：

### 已落地（对照方案）

| 方案项 | 落地实现 |
|--------|----------|
| Phase 0 按人发码 | `state.invites` 升级 `{code → {name, role, uid, tid?, domain_role?}}`；裸码保留旧 fallback（INV-DEMO-1 出厂行为不变）；运维台「🔐 成员」发码/吊销（最后一个码保护） |
| token 堵兜底 | users 查不到 uid 一律 401（index.js useAuth） |
| 资产登录墙 | `/var/out/*`、`/var/assets/*` 凭据三路校验（Bearer/Cookie `theater_tok`/`?token=`）＋域级 ACL（资产归属反查索引，store.rev 缓存失效） |
| Phase 1 域核心 | `core/tenants.js`（accessOf/guard*/scopedView/membershipsOf）；state.js 只读投影（心脏）；写侧归属校验覆盖 projects/episodes/cards 全写端点（域外 404）；bus SSE 订阅端按域过滤；engine/账本 stamp tid |
| Phase 2 RBAC | owner/admin/member/viewer 四角色全链（域码带 domain_role、成员身份变更、owner 转让、删域=仅空域+默认域保护）；域级预算护栏（Σ本域 cost > 预算×120% → 暂停全域进行中集＋告警，billing 账本行带 tid）；按域计费聚合 `GET /api/tenants/:tid/billing` |
| 前端 | 设置页「🌐 域」面板（切换/建域/成员管理/预算/计费/域码）；nav 当前域名显示 |

### 超出方案的增量（同日演进）

1. **引擎目标全可配（离开 5060 Ti 也能活）**：lane→node→IP 由注册表绑定（并行线已落地）；本轮补齐——用户级默认算力（`users[uid].driver`，建集路由=请求节点>用户默认>首节点）、云 API 一等目标（node `kind:"cloud"` ＋ `img_cloud` worker，OpenAI 兼容 /v1/images/generations 适配，计费=单价×张数）、`vidsark` 拼写 bug 修正、engine 回退去 local 写死。视频/音乐云适配器待具体服务商再开 lane（路由层零改动）。
2. **LLM 大脑统一面板**：运维台算力节点页顶部——剧场 AI 能力（AI 剧本/审查/建议片）＋制片助手同一份配置的显性化；未配置时醒目引导（当前规则兜底清单）；助手面板未配置/离线提示条（运营可点击直达）。
3. **删除能力**：项目（仅空）/集（级联＋产物清理＋排队任务取消）/域（仅空域），全部二次确认＋审计带计数。
4. **自愈层**：启动幂等补 stamp（漏 tenantId 实体归默认域）＋投影回退（漏 stamp 实体默认域可见）——真机踩过「副驾建集漏 stamp 全域隐形」。

### 未开工

- Phase 3（signed 分享链接/跨域协作）：按商业化节奏另开。
- 静态资产域级 ACL 的索引反向覆盖：art 反查索引已建；素材中心 asset_lib（并行线新增）的租户归属尚未纳入索引，列为下轮事项。
