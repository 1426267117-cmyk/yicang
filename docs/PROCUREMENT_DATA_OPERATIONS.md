# 采购数据时效与自动化运维

“今日采购建议”页会同时展示 MUKU 库存和 Shopify 官方订单源的运维状态，避免把页面能打开误认为数据正在持续更新。

## 页面展示口径

| 项目 | MUKU | Shopify |
| --- | --- | --- |
| 最近成功 | ERP 最近完整切换库存快照的时间 | 每家官方店铺最近一次完整订单同步成功时间 |
| 到期时间 | 上游生成时间与 ERP 成功时间中较早者加采购时效 | 店铺最近成功时间加订单时效 |
| 受保护入口 | `POST /api/connectors/muku/refresh` | `POST /api/connectors/shopify/reconcile` |
| 托管调度 | 可由 Sites MCP 的 `refresh_procurement_sources` 同时处理 | 可由 Sites MCP 的 `refresh_procurement_sources` 同时处理 |
| 外部调度 | 仅在部署侧确认后显示已配置 | 仅在部署侧确认后显示已配置 |
| 阻断 | 密钥、调度身份/认证、调度声明、源时间或同步状态缺失都会显示原因 | 无官方店铺、调度身份/认证、调度声明、同步过期或失败都会显示原因 |

未知时间保持“未知”，不会补成 `0` 或伪装成正常。Shopify 每家店独立展示最近成功和有效截止；一家店失败不会隐藏其他店的成功，但采购安全门仍按官方订单源的新鲜度阻断不安全转换。

## 页面刷新不是采集任务

- 刷新浏览器会重新读取 ERP 当前状态。
- MUKU 状态接口在刷新到期时可能顺带触发一次后台更新；这只是机会式刷新，不保证无人访问时持续运行。
- Shopify 不会因为刷新浏览器而同步。Webhook 用于变化通知，周期增量对账用于补漏，二者都需要后端任务能力。
- 因此页面会明确显示当前采用 Sites MCP 托管任务，还是内部任务入口加外部调度。只有当前模式所需的身份、数据源和真实调度均满足，才显示自动化已闭环。

## 部署配置

可选择以下一种调度方式：

### Sites MCP 托管任务

1. 配置 `ERP_AUTOMATION_ALLOWED_EMAILS`，发布包含 Site MCP 的版本，并连接站点插件。
2. 先手工调用一次 `refresh_procurement_sources`，确认 MUKU 只读刷新和 Shopify 增量对账均返回安全结果。
3. 创建 Sites 托管计划任务。平台当前每小时最多运行一次，因此建议同时把库存和订单时效设为 75 分钟，保留 15 分钟调度缓冲。
4. 任务真实保存并验证后设置 `ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED=true`；此模式不要求 `ERP_INTERNAL_JOB_TOKEN` 或下面两个旧调度变量。

### 内部任务入口加外部调度器

1. 将 `ERP_INTERNAL_JOB_TOKEN` 作为至少 32 个随机字符的服务端 Secret 配置；不要放入前端、Git、日志或聊天。
2. 让部署环境的外部调度器使用 Bearer Token 调用两个受保护入口。建议 MUKU 每 5～10 分钟检查一次，Shopify 每 15 分钟增量补漏一次。
3. 完成真实调用验证后，分别设置：
   - `ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED=true`
   - `ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED=true`
4. 若尚未配置调度，变量保持 `false`；端点代码存在不代表生产调度已经运行。

这些变量只负责如实展示部署状态，不会创建调度器，也不会修改 MUKU 看板、共享盘、Shopify 订单、库存、付款或发货状态。
