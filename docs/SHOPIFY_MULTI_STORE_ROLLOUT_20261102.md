# Shopify 四店订单接入交付清单（2026-11-02）

本文只记录 ERP 的只读订单接入状态。线上状态会变化，发布或授权前必须重新调用 ERP 状态接口核验，不能把本文件当作实时凭证。

## 当前已核验状态

| 店铺 | ERP `storeKey` | 官方域名候选 | 当前结果 | 还缺什么 |
| --- | --- | --- | --- | --- |
| BizFurniz | `bizfurniz` | 已用官方 Shop ID 核验实际授权域名 | 已授权、身份已核验、同步空闲且无错误；ERP 已保存 9 个真实订单事实 | 上线新版后验证定时增量对账；如需 60 天前订单，另行申请 `read_all_orders` |
| ZIMASYA | `zimasya` | `346c85.myshopify.com` | 未配置应用、未授权、未同步 | 该店可安装应用的 Client ID/Secret，以及店主安装授权 |
| Kaguyasu | `kaguyasu` | `officebaseca.myshopify.com` | 未配置应用、未授权、未同步 | 同上 |
| Anzhap | `anzhap` | `anzhap.myshopify.com` | 未配置应用、未授权、未同步 | 同上 |

BizFurniz 当前事实统计为 9 个订单、2 个退款对象、10 个履约对象；最新订单源更新时间为 `2026-11-02T08:25:50Z`。这只是核验时快照，不代表持续调度已经上线。

## ERP 已完成的四店能力

- 四家店使用独立 `storeKey`、域名白名单和环境变量前缀，不按相似名称合并。
- OAuth 开始、回调、令牌加密保存、官方 Shop ID 核验、`read_orders` 权限核验均按 `storeKey` 通用实现。
- 每家店独立保存同步游标、失败状态、订单/订单行/退款/履约；默认后台对账会发现全部已授权店铺。
- 某店授权或配置失败时只记录该店失败，其他已授权店继续同步。
- 回调成功后自动尝试注册订单创建/更新/取消和退款 Webhook；履约变化由订单更新通知与周期增量对账补齐。
- ERP 当前只读 Shopify，不会修改订单、库存、付款或发货状态。

## 明天需要一次性完成的人工事项

1. 先判断另外三店是否与 BizFurniz 属于同一个 Shopify Plus organization。
   - 同一 Plus organization 且应用允许 multi-store install 时，可以评估复用同一个 custom-distribution app。
   - 否则每家生产店创建各自的 custom-distribution app；不要尝试把 BizFurniz 的单店专属安装链接装到其他组织。
2. 每个应用只申请 ERP 当前所需的 `read_orders`，并配置对应回调：
   - `/api/connectors/shopify/oauth/zimasya/callback`
   - `/api/connectors/shopify/oauth/kaguyasu/callback`
   - `/api/connectors/shopify/oauth/anzhap/callback`
3. 由 Sites 项目所有者把各店 `CLIENT_ID` / `CLIENT_SECRET` 配成后端 Secret，再发布同一版本。不要把值写进 Git、聊天、前端或交接文档。
4. 在 ERP “平台订单”页逐店点击“授权只读订单”，由能安装应用的店主确认。
5. 每店授权后先回补最近 7 天并核对 Shop ID、订单数、订单行、退款和履约；确认幂等后再扩展历史范围与定时任务。

对应变量名：

| 店铺 | Client ID | Client Secret |
| --- | --- | --- |
| ZIMASYA | `SHOPIFY_ZIMASYA_CLIENT_ID` | `SHOPIFY_ZIMASYA_CLIENT_SECRET` |
| Kaguyasu | `SHOPIFY_KAGUYASU_CLIENT_ID` | `SHOPIFY_KAGUYASU_CLIENT_SECRET` |
| Anzhap | `SHOPIFY_ANZ_CLIENT_ID` | `SHOPIFY_ANZ_CLIENT_SECRET` |

## 历史订单边界

Shopify 官方 `read_orders` 默认只允许访问最近 60 天订单。若采购或财务确实需要更早历史，应用还需获得 Shopify 对 `read_all_orders` 的许可并重新授权；未取得许可前 ERP 不应把“最近 7 天回补成功”描述成“历史全量完成”。大数据量历史回补后续可评估 Shopify Bulk Operations，但当前逐页同步已满足首店验收和持续增量需求。

## 已核验的官方依据

- [Shopify 应用分发方式](https://shopify.dev/docs/apps/launch/distribution)：custom distribution 通常面向一个生产店；同一 Plus organization 可允许多店安装。
- [Shopify 选择分发方式](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)：多店 custom app 的组织限制和安装链接流程。
- [Shopify 订单查询](https://shopify.dev/docs/api/admin-graphql/latest/queries/order)：默认最近 60 天；更早订单需要 `read_all_orders`。
- [Shopify 访问令牌](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)：后台任务和 Webhook 应使用 offline access token，并按返回有效期安全刷新。

