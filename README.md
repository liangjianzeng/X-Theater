# X-Theater · 剧场（Theater Studio）

AI 短剧全链路创作 SaaS —— 一期完全自部署（5060 Ti ＋ DGX Spark），完全独立产品，全界面 H5 双端同等。

## 文档地图（docs/）

| 文档 | 内容 |
|---|---|
| [theater-product-master-plan.md](docs/theater-product-master-plan.md) | **总纲（评审基线）**：定位/FR/架构/合规/路线图 |
| [theater-phase1-plan.md](docs/theater-phase1-plan.md) | 一期执行细分：WBS 280pd、双里程碑、周排程、验收 V1–V10 |
| [theater-test-acceptance-plan.md](docs/theater-test-acceptance-plan.md) | **全业务自动化测试与验收规划**：分层模型 L0–L4、覆盖矩阵（34 端点/12 视图/FR）、韧性·安全·property 系列、UI 双 lane、执行节律与证据链治理 |
| [h3-line-diagram.png](docs/h3-line-diagram.png) | **MINIMAX H3 线全链路一张图**（长图）：业务流程×编排节点×固化模板×模型权重四层视图（源 [h3-line-diagram.html](docs/h3-line-diagram.html)） |
| [h3-diagram-1-overview.png](docs/h3-diagram-1-overview.png) | **系列竖图 1/4 全景立项**：十步总路线·五层图例·剧本源头·C1 策划＋九幕五层速览表（源 [h3-diagram-1-overview.html](docs/h3-diagram-1-overview.html)） |
| [h3-diagram-2-identity.png](docs/h3-diagram-2-identity.png) | **系列竖图 2/4 身份链★**：初始定妆三入口→试妆试镜 C2S（FL2VA 多角度视频→抽帧打分→viewRefs）→分镜「选角度帧＋只换背景壳」（源 [h3-diagram-2-identity.html](docs/h3-diagram-2-identity.html)） |
| [h3-diagram-3-production.png](docs/h3-diagram-3-production.png) | **系列竖图 3/4 拍摄成片**：配音·音乐·预览→逐镜原生声画拍摄→机审复审→FFmpeg 真合成（源 [h3-diagram-3-production.html](docs/h3-diagram-3-production.html)） |
| [h3-diagram-4-reference.png](docs/h3-diagram-4-reference.png) | **系列竖图 4/4 台账纪律**：14 项模型权重台账＋8 条横切纪律＋源文件索引（源 [h3-diagram-4-reference.html](docs/h3-diagram-4-reference.html)） |
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
