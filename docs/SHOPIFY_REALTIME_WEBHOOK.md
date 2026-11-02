# Shopify 订单近实时通知

ERP 通过店铺级 HTTPS 回调接收 Shopify 订单变化：

```text
https://yicang-erp.champztj.chatgpt.site/api/connectors/shopify/webhooks/{storeKey}
```

BizFurniz 的 `storeKey` 为 `bizfurniz`。回调会使用该店铺应用的 Client Secret 对原始请求体做 HMAC-SHA256 验签，并校验 Shopify 店铺域名和 ERP 已保存的授权归属。

## 建议先注册的主题

- `ORDERS_CREATE`
- `ORDERS_UPDATED`
- `ORDERS_CANCELLED`
- `REFUNDS_CREATE`

`ORDERS_UPDATED` 到达后，后台应使用事件中的 Order GID 调用现有 GraphQL `fetchOrder`，重新读取完整订单、订单行、退款和履约状态。Webhook 只充当通知，不把事件载荷直接当成最终业务事实。

第一阶段不要注册 `FULFILLMENTS_CREATE` / `FULFILLMENTS_UPDATE`；它们可能需要额外的履约读取权限。订单更新通知加完整订单重读已经能覆盖当前只读采购需求场景。`ORDERS_DELETE` 不进入完整订单重读队列。

## 注册方式

部署包含数据库迁移 `0004` 和 `0005` 的版本后，OAuth 回调会使用 ERP 后端当次授权会话自动幂等创建或收敛这四个订阅。访问令牌只在后端内存和加密凭证存储中使用，不能复制到浏览器、聊天、脚本参数或文档。

订阅采用最小字段：订单主题只接收 `id`、`admin_graphql_api_id`；退款主题只接收 `order_id`。这样 webhook 只负责定位订单，不传输客户姓名、邮箱或地址，也能降低请求体过大的风险。

```graphql
mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}
```

变量示例：

```json
{
  "topic": "ORDERS_CREATE",
  "subscription": {
    "uri": "https://yicang-erp.champztj.chatgpt.site/api/connectors/shopify/webhooks/bizfurniz",
    "format": "JSON",
    "includeFields": ["id", "admin_graphql_api_id"]
  }
}
```

四个主题均注册成功后，再用 `webhookSubscriptions` 查询核对主题和回调地址。

## 接收与处理规则

1. 请求体最多 1 MiB，读取过程中超限立即停止。
2. 先验签，再解析 JSON；验签失败不入库。
3. 使用 `X-Shopify-Webhook-Id` 做投递幂等。
4. 只保存主题、店铺、Order GID、触发时间和载荷哈希，不保存客户地址或邮箱原文。
5. 新事件写入 `shopify_webhook_events` 的 `pending` 队列；仅新入队事件会启动后台消费，重复投递不会重复触发。
6. 接收成功后通过 Worker `waitUntil` 即时处理最多一个订单，先快速向 Shopify 返回安全响应；积压和延迟重试交给补偿任务。
7. `POST /api/connectors/shopify/webhooks/process` 是独立内部批处理入口，请求体可传 `{ "maxEvents": 10 }`。它不使用普通用户登录或 `connectors:sync` 权限，即使 `ERP_DEV_OPEN_ACCESS=true` 也必须携带 `Authorization: Bearer <ERP_INTERNAL_JOB_TOKEN>`。
8. `ERP_INTERNAL_JOB_TOKEN` 必须以至少 32 个随机字符配置为服务端 Secret；不得写入前端、仓库、日志或本文档。未配置返回 503，无或错误 Token 返回 401。
9. 部署新版本后可调用 `POST /api/connectors/shopify/webhooks/register`，使用 ERP D1 中已经保存的 Shopify 授权幂等注册四个订阅，无需重新走 OAuth。此入口同样只接受 `ERP_INTERNAL_JOB_TOKEN`，开放开发模式不能绕过；它会先核对店铺官方 Shop ID、域名和唯一租户归属，且响应不包含访问令牌或客户数据。
9. 消费者用租约条件抢占事件，再调用现有完整订单读取与幂等落库逻辑；失败按 1 分钟、5 分钟、15 分钟、1 小时退避，最多五次，最终失败记录保留。
10. 应定期调用内部批处理入口，确保低流量店铺的退避事件和过期租约能继续推进；不要创建公开的订阅注册接口。
11. 保留周期性增量同步作为漏单补偿，Webhook 不能取代对账重扫。

订阅注册在 OAuth 凭证保存后由后台任务幂等执行。注册失败不会影响已成功的授权回跳，日志只记录安全错误码，绝不记录 Token；失败状态展示与主动重试入口属于后续增强项。

## 周期增量对账

后台调度器应每 15 分钟调用一次 `POST /api/connectors/shopify/reconcile`。这个入口复用人工同步已经验证过的增量水位、6 小时重叠窗口、分页断点、同步租约和订单幂等写入，不会另造一套订单落库逻辑。

它是内部任务入口，不使用普通用户登录。即使 `ERP_DEV_OPEN_ACCESS=true`，请求也必须携带：

```text
Authorization: Bearer <ERP_INTERNAL_JOB_TOKEN>
Content-Type: application/json
```

空请求体或 `{}` 会处理 ERP D1 中已经保存 OAuth 授权的店铺，以及服务端已配置 `ADMIN_ACCESS_TOKEN` 的兼容店铺；不会尝试仅配置 Client ID/Secret 但尚未授权的候选店铺。同一店铺两种凭证同时存在时，租户绑定的 D1 OAuth 授权优先且只同步一次。需要限制本次店铺或页数时可传：

```json
{
  "storeKeys": ["bizfurniz"],
  "maxPages": 100
}
```

首次同步没有完成水位时，任务会为该店返回 `SHOPIFY_INITIAL_RANGE_REQUIRED`，应先通过人工同步明确历史起始时间完成回补。已有水位后，每次定时任务按更新时间增量读取并自动重扫重叠窗口；重复运行由现有主键和内容哈希保证不重复制造订单。访问令牌临近或已经过期时，入口会复用加密刷新凭证和刷新租约自动轮换，响应、日志和文档均不得包含访问令牌或刷新令牌。

任务逐店隔离：一家店失败不会抹掉其他店的成功结果。全成功返回 HTTP 200；存在失败或明确请求了尚未授权的店铺时返回 HTTP 207。如果当前范围没有任何 D1 OAuth 或服务端 Token 目标，则返回 HTTP 422，并明确给出 `noConfiguredStores: true` 和 `skipReason: "SHOPIFY_NO_CONFIGURED_STORES"`，不会把空跑伪装成同步成功。响应只包含 `storeKey`、分页数、订单新增/更新/未变化计数、完成时间以及安全错误码和可重试标记，不包含租户 ID、店铺域名、客户资料或凭证。

`ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED=true` 只用于声明外部调度器已经实际配置并验证。端点代码存在并不代表平台已经自动调用；未配置时保持 `false`。调度器使用的 `ERP_INTERNAL_JOB_TOKEN` 必须作为服务端 Secret 管理，不能写入前端、仓库、命令历史或聊天。
