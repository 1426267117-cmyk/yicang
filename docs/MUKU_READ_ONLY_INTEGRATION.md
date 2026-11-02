# MUKU 看板只读接入说明

## 边界

- ERP 只调用 MUKU 的 `GET /api/integrations/erp/v1/export`。
- MUKU 看板、采集任务、数据库、共享盘原始文件和已有授权均保持不变。
- API Key 只通过后端环境变量 `MUKU_DASHBOARD_API_KEY` 提供；不得使用 `NEXT_PUBLIC_` 前缀，也不得写入浏览器代码、日志或 Git。
- MUKU 数据保存到 ERP 独立的只读快照表，不覆盖 ERP 的订单、库存账本、采购单或收货结果。

## 当前数据链路

```text
MUKU 只读出口
  -> ERP 后端连接器（鉴权、超时、限流重试、完整分页）
  -> ERP 独立快照（旧快照保留，完整新快照成功后才切换）
  -> ERP 新鲜度判定（库存采购安全门）
  -> 库存页中的“MUKU 只读库存 / 库存风险”
```

当前落库数据集：

| 数据集 | ERP 用途 | 是否改业务库存 |
| --- | --- | --- |
| `inventory` | 跨仓 SKU 库存参考与采购判断 | 否 |
| `inventory-details` | 箱/批次/库龄等明细追溯 | 否 |
| `inventory-risk` | 低库存、超龄、滞销风险提示 | 否 |
| `source-status` | 数据源新鲜度、异常和延迟说明 | 否 |

MUKU 清单中其余数据集已识别，后续按业务阶段接入：履约单、库存日快照、Shopify 日汇总与财务、Shopify SKU 30 日、渠道日汇总、店铺状态、渠道报表运行状态。

## 数据规则

- `null` 表示未知或未提供，界面显示“未知”，不能改成 `0`。
- 库存业务时区按源数据元信息保存，当前主要为 `Asia/Shanghai`；Shopify/渠道业务日期主要按 `America/Los_Angeles`。
- 金额分析以 `shopify-finance` 为主，普通日汇总只用于辅助分析和对账。
- 每次同步先拉完全部分页并校验记录数，再切换有效快照；空数据、分页不完整、鉴权失败或网络失败都不替换上一份有效快照。
- 重复同步通过幂等键和内容哈希防重，不重复生成同一业务结果。

## 自动保持新鲜与采购安全门

- `GET /api/connectors/muku/status` 会返回 `freshness`。默认要求 `inventory` 同时存在有效快照、状态可用、上游 `generatedAt` 与 ERP `lastSuccessAt` 均不超过 30 分钟，才设置 `readyForProcurement=true`。
- 缺少快照、时间未知/无效、超过阈值，或最近同步处于 `failed/delayed` 时，响应会给出明确的 `blockingReasons`；未知状态不会按 `0` 或“正常”处理。
- 状态页请求只在连接已配置且刷新到期时，用 `waitUntil` 在响应后触发一次后台刷新。请求不会等待 MUKU 全量分页，10 分钟内也不会重复尝试。刷新浏览器本身只是重新读取状态，不能当作稳定采集或生产调度。
- 刷新期间仍读取上一份 active 快照；只有完整分页校验成功才切换。失败会保留旧快照，但采购安全门会阻止把失败状态当成最新库存。
- 阈值可通过后端变量 `MUKU_FRESHNESS_MAX_AGE_MINUTES` 调整（默认 30，允许 5～1440）；限频可通过 `MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES` 调整（默认 10，允许 1～1440）。

### 受保护的任务入口

部署平台可使用已有 `ERP_INTERNAL_JOB_TOKEN`，以 `Authorization: Bearer <token>` 调用 `POST /api/connectors/muku/refresh`。空请求体按“到期才刷新”执行；仅在人工故障处理时可传 `{"force":true}`。接口和错误响应都使用 `Cache-Control: no-store`，不会返回 MUKU API Key。

当前工程只提供受保护的任务入口，没有声明 Cloudflare Cron、Sites 定时器或 Codex automation 已经配置。生产若需要无人访问页面时仍定时刷新，必须由实际部署环境的调度器调用此接口；建议每 5～10 分钟触发一次，由服务端限频和幂等逻辑决定是否真正拉取。

只有外部调度器已经实际配置并验证后，才把服务端变量 `ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED` 设为 `true`。此变量只是部署侧的明确声明，不会自行创建定时任务。`GET /api/connectors/muku/status` 会分别返回内部任务密钥是否配置、受保护入口是否就绪、外部调度是否声明配置及下次刷新到期点；不能用“入口代码存在”替代“调度已运行”。

## 采购规划闭环

- “今日采购建议”按 ERP SKU 计算：`订单未履约需求 + 安全库存 - MUKU 可用库存 - ERP 未完成采购覆盖`，再应用 MOQ 与包装量。
- MUKU 在途只展示，不参与抵扣；未确认它与 ERP 采购链是否重叠前，不把它当成可用库存。
- MUKU SKU 必须唯一匹配或人工映射到 ERP SKU。未映射、歧义、库存未知、源时间过旧、到货尚未在 MUKU 中确认时都 fail-closed。
- MUKU 导出生成时间与仓库业务源时间分别校验。默认导出/ERP 同步不超过 30 分钟，仓库源行不超过 48 小时。
- 只有非 LOCAL-QA 的官方订单源且最近成功同步未超过 30 分钟，建议才能转采购申请。
- 转申请时服务端重新计算并核对 `recommendationVersion`；旧建议、重复提交、MOQ/包装量无法安全承载等情况返回冲突，不产生第二份业务结果。
- 采购申请、复审、正式采购单、分批收货和库存流水继续使用现有 ERP 流程；取消和历史记录不物理删除。

当前安全边界：纯安全库存补货还没有独立的 replenishment demand，因此只展示、不伪造平台订单；同一订单需求已有 active 部分采购后再次出现缺口，会明确提示人工处理旧采购链，不创建第二条 active 需求。

## 本地配置与验证

1. 在 `.env.local` 或部署平台的后端 Secret 中设置：
   - `MUKU_DASHBOARD_BASE_URL`
   - `MUKU_DASHBOARD_API_KEY`
   - `ERP_INTERNAL_JOB_TOKEN`（仅部署调度需要，至少 32 个随机字符）
   - 可选：`MUKU_FRESHNESS_MAX_AGE_MINUTES`、`MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES`
   - `ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED=true`（仅在外部调度已实际配置并验证后设置）
   - 可选：`MUKU_INVENTORY_SOURCE_MAX_AGE_MINUTES`（默认 2880）、`ERP_ORDER_SYNC_MAX_AGE_MINUTES`（默认 30）
2. 启动 ERP 后，在库存页点击“测试连接”。
3. 测试成功后点击“同步 MUKU 只读数据”。
4. 在“MUKU 只读库存”和“库存风险”页签核对记录数、数据时间、时区和来源状态。

部署环境需要单独配置相同名称的 Secret；本地 `.env.local` 不会自动上传，也不得提交到 Git。

### 本地 Workerd 网络出口

本地 Miniflare/Workerd 的 `fetch` 不使用系统 `HTTPS_PROXY` 时，MUKU 前的 WAF 可能拒绝它的直连请求。开发环境可选使用 Vite 的本机出口：

1. 在本机 `.env.local` 增加
   `MUKU_LOCAL_EGRESS_URL=http://127.0.0.1:3000/__muku-local-egress/v1/export`。
2. 在启动 Vite 的同一 Node 进程中设置 `NODE_USE_ENV_PROXY=1`，并确保系统 `HTTPS_PROXY` 已配置，然后运行 `npm run dev`。
3. 再从 ERP 页面执行“测试连接”。

该出口仅在 Vite `serve` 模式注册，只接受本机 loopback 请求。它把请求固定到 MUKU 官方域名的唯一 `GET /api/integrations/erp/v1/export` 路径，并且限制数据集、查询参数、重定向、JSON 响应和 8 MiB 响应上限。`Authorization` 仅在内存中转发，不会记录；浏览器始终只请求 ERP，不直连 MUKU。

生产部署不要配置 `MUKU_LOCAL_EGRESS_URL`。变量留空时，ERP 后端会直接请求 MUKU 的 HTTPS 出口。
