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

部署包含数据库迁移 `0004` 的版本后，用 ERP 后端已加密保存的店铺授权，通过 Shopify Admin GraphQL API 对每个主题执行 `webhookSubscriptionCreate`。不要把访问令牌复制到浏览器、聊天、脚本参数或文档。

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
    "format": "JSON"
  }
}
```

四个主题均注册成功后，再用 `webhookSubscriptions` 查询核对主题和回调地址。

## 接收与处理规则

1. 请求体最多 1 MiB，读取过程中超限立即停止。
2. 先验签，再解析 JSON；验签失败不入库。
3. 使用 `X-Shopify-Webhook-Id` 做投递幂等。
4. 只保存主题、店铺、Order GID、触发时间和载荷哈希，不保存客户地址或邮箱原文。
5. 新事件写入 `shopify_webhook_events` 的 `pending` 队列。
6. 后续消费者应以条件更新/租约抢占事件，再调用现有完整订单读取与幂等落库逻辑。
7. 保留周期性增量同步作为漏单补偿，Webhook 不能取代对账重扫。
