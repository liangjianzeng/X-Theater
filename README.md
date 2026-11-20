# X-Theater · 剧场（Theater Studio）

AI 短剧全链路创作 SaaS —— 一期完全自部署（5060 Ti ＋ DGX Spark），完全独立产品，全界面 H5 双端同等。

## 文档地图（docs/）

| 文档 | 内容 |
|---|---|
| [theater-product-master-plan.md](docs/theater-product-master-plan.md) | **总纲（评审基线）**：定位/FR/架构/合规/路线图 |
| [theater-phase1-plan.md](docs/theater-phase1-plan.md) | 一期执行细分：WBS 280pd、双里程碑、周排程、验收 V1–V10 |
| [theater-test-acceptance-plan.md](docs/theater-test-acceptance-plan.md) | **全业务自动化测试与验收规划**：分层模型 L0–L4、覆盖矩阵（34 端点/12 视图/FR）、韧性·安全·property 系列、UI 双 lane、执行节律与证据链治理 |
| [theater-ux-design.md](docs/theater-ux-design.md) | 竞品 UX 拆解与体验机制 |
| [theater-ui-interaction-design.md](docs/theater-ui-interaction-design.md) | 一期实现级 UI 交互规范 v1.5（S1–S18） |
| [theater-infer-backend-adr.md](docs/theater-infer-backend-adr.md) | ADR-001 推理计算后端 |
| [theater-client-web-adr.md](docs/theater-client-web-adr.md) | ADR-002 端侧选型（Web SPA 双宿主） |
| [theater-agent-platform-adr.md](docs/theater-agent-platform-adr.md) | ADR-003 智能体平台（L2·DSH 双模式） |
| [theater-mode-plan.md](docs/theater-mode-plan.md) | 市场/商业模式（归档态） |
| [theater-review-report-2026-11-20.md](docs/theater-review-report-2026-11-20.md) | 评审汇总与战略裁决记录 |
| [theater-preflight-confirmation-2026-11-20.md](docs/theater-preflight-confirmation-2026-11-20.md) | 开工前最终确认（GO 判定） |

## UI 原型

[docs/html-prototype/index.html](docs/html-prototype/index.html) —— S1–S18 全量可点击，桌面/H5 设备切换。零依赖，本地起服务预览：

```bash
node docs/html-prototype/_serve.js   # http://127.0.0.1:8765/
```
