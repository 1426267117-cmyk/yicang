# Sites 托管采购刷新工具

ERP 在 `/mcp` 暴露一个无状态、JSON-RPC 2.0 的 Site MCP server，协议版本为 `2026-07-28`。它用于让 Sites 官方托管计划任务检查并刷新采购依赖的数据，不替代 ERP 页面权限，也不把 MUKU 或 Shopify 凭证放进任务提示词。

## 工具

- `get_procurement_freshness`：只读检查最多 20 个 ERP 租户的 MUKU 库存快照和 Shopify 订单同步时效。结果只包含状态、时间、数量和安全错误码，不包含订单、客户、Token、域名或原始响应。
- `refresh_procurement_sources`：按 ERP 已保存的固定配置调用 `refreshMukuIfDue`，再对这些租户内已授权的 Shopify 店铺执行增量对账。工具不接受 URL、凭证、店铺或租户参数，单次 Shopify 同步最多 20 页。

刷新工具会重复使用现有幂等、增量游标、重叠窗口和失败保留旧有效数据的逻辑。它不会修改 Shopify 订单、库存、付款或发货状态，也不会写入 MUKU 看板或共享盘。

## 写工具权限

Sites 会在 MCP 请求中转发已验证的 `oai-authenticated-user-email`。刷新工具还会将该邮箱与部署环境中的非秘密变量进行精确匹配：

```dotenv
ERP_AUTOMATION_ALLOWED_EMAILS=owner@example.com,operator@example.com
```

变量缺失、为空、邮箱头缺失或调用者不在白名单时，刷新工具均会失败关闭。`ERP_DEV_OPEN_ACCESS=true` 不能绕过这项检查。不要把 Token、Cookie、App Secret 或 API Key 写进这个变量或计划任务提示词。

托管计划任务已经实际保存并验证后，再设置以下非秘密状态变量：

```dotenv
ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED=true
```

该变量只用于让采购页面准确展示 Sites MCP 调度状态，不会自行创建任务。Sites 调度模式使用上面的允许邮箱和 Site MCP 身份，不要求 `ERP_INTERNAL_JOB_TOKEN`，也不要求旧版 `ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED` / `ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED`。原有内部任务入口与外部调度变量继续保留兼容。

## 上线顺序

1. 在 Sites 部署环境配置 `ERP_AUTOMATION_ALLOWED_EMAILS`，并保留既有的 D1、MUKU Secret、Shopify 加密密钥及店铺授权。
2. 由 Site 所有者发布包含 `"capabilities": ["mcp"]` 的版本。发布后 Sites 会为该 Site 创建或刷新私有 App/plugin。
3. 先连接该 plugin，并调用只读工具核对状态；再用白名单账号手工调用一次刷新工具，核对安全统计和 ERP 页面数据。
4. 验证成功后，在 Sites 中建立托管计划任务。当前 Sites 平台限制同一任务每小时最多运行一次，因此生产任务按每小时一次执行；任务只需调用 `refresh_procurement_sources`，不要在提示词中附加 URL、租户、凭证或密钥。
5. 每小时调度时，将 `MUKU_FRESHNESS_MAX_AGE_MINUTES` 和 `ERP_ORDER_SYNC_MAX_AGE_MINUTES` 设置为 75，保留 15 分钟调度缓冲；超过 75 分钟仍须 fail-closed。只有任务已保存且至少一次运行验证成功后，才设置 `ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED=true` 并重新部署当前版本。

截至 2026-11-03，Site MCP 已随易仓 ERP 发布，生产已保存启用的每小时采购数据刷新任务。`09:20`（Asia/Shanghai）首轮任务调用返回 HTTP 200；MUKU 快照刷新至 `09:19:42`，BizFurniz Shopify 同步完成于 `09:20:15`，采购数据源无新鲜度阻断。`ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED=true` 已写入生产环境，随 `v17` 重新部署后页面会准确显示自动化闭环。

## 失败与排查

- `AUTHENTICATED_USER_REQUIRED`：Sites 未转发已验证邮箱；应从已连接的 Site plugin 调用。
- `AUTOMATION_ALLOWLIST_NOT_CONFIGURED`：部署环境尚未配置写工具白名单。
- `AUTOMATION_CALLER_NOT_ALLOWED`：当前已验证邮箱不在白名单中。
- 页面仍显示“自动化尚未闭环”：核对任务是否已实际保存并运行，再核对 `ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED=true` 和允许邮箱变量是否已随部署生效。
- `DATABASE_UNAVAILABLE`：部署没有绑定 ERP D1。
- MUKU 或 Shopify 的其他错误只返回安全错误码；已有成功快照和订单数据不会因本次失败被清空。

`server/discover` 与 `tools/list` 可用于协议和工具发现。所有响应均设置 `Cache-Control: no-store`。
