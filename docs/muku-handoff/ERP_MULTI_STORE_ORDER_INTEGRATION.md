# ERP 多店铺订单接入实施说明

更新时间：2026-10-30  
范围：仅当前 ERP 工程及其 D1。MUKU 看板、采集任务、凭证和共享盘原始数据保持不动。

## 1. 当前结论

当前工程是可维护的自研 ERP（Next/Vinext + Cloudflare D1），不是易仓厂商商用后台。原 `orders` 表是人工运营单：单 SKU、单仓、正金额，审核/发货会触发库存预占和扣减。因此平台原始订单没有写入该表，而是新增独立的只读事实层，避免 Shopify 的取消、退款或履约更新误动 ERP 库存。

当前已完成无需店铺授权的部分：

- Shopify Admin GraphQL `2026-07` 只读连接器；
- HTTP 408/425/429/5xx 有界重试，GraphQL `THROTTLED` 重试，错误信息脱敏；
- 官方 Shop ID、`myshopify.com` 域名和已授予 scope 的运行时核验；
- 按 `UPDATED_AT` 排序的外层订单分页；
- 订单行、退款行、退款交易和履约行二级分页；
- 固定上界的历史/增量窗口、6 小时重叠回扫、逐页断点和完成水位；
- 单店单资源同步租约、逐订单心跳和 run ID 条件更新，阻止重复点击互相覆盖游标；
- 订单图事务式 D1 batch upsert，重复抓取不重复入库；
- 订单、订单行、退款、退款交易、履约、追踪号、SKU 映射候选和原始快照分表保存；
- 只读同步 API、状态 API、管理员权限控制及“平台订单”页面。
- 真实同步前强制配置公司邮箱/域名访问名单；公共演示站不能配置真实店铺凭证。

当前没有任何真实 Shopify ERP 凭证，因此没有冒充“已接通生产店铺”，也没有写入模拟订单。

## 2. 可复用部分与实际处理

| 交接包能力 | ERP 处理 |
|---|---|
| Shopify 域名校验 | 迁移为严格 `*.myshopify.com` 校验，并阻止重定向泄露凭证 |
| 408/429/5xx、限流重试 | 迁移为 Workers `fetch` 有界退避；日志和响应不含 Token、请求头或原始错误体 |
| `currentAppInstallation.accessScopes` | 在首次读取时核对真实安装权限，不相信仅配置的 scope 字符串 |
| `pageInfo/endCursor` 防循环 | 外层订单及四类内层连接均检查空游标、重复游标和安全页数上限 |
| 顶层数组读取上限 | `refunds(250)`、`fulfillments(250)` 或 `trackingInfo(100)` 达到上限即判定响应可能截断并停止写该订单，不把不完整响应标成完整事实 |
| 店铺时区和原始时间 | 保存原始 ISO 时间、店铺 IANA 时区，并单独计算店铺业务日 |
| ShopifyQL 财务 | 暂不写订单事实，仅保留为后续汇总对账来源 |
| 运去哪分仓分页/业务号 | 只完成设计复核，尚未迁移到可执行连接器；必须逐接口取得 ERP 独立授权 |
| 店铺/仓库映射 | 看板 ID 仅作候选别名；正式源身份只接受平台官方 ID，未验证仓库别名不自动合并 |

没有运行 `reference/` 下任何脚本，也没有把参考代码当成已安装连接器。

## 3. ERP 字段映射

| Shopify | ERP | 规则 |
|---|---|---|
| `shop.id` | `platform_stores.official_store_id` | 官方身份；与配置域名不一致即停止写入 |
| `Order.id` | `platform_orders.source_order_id` | 唯一键为 tenant + store + source order ID |
| `createdAt/updatedAt` | `source_created_at/source_updated_at` | 原始时间不覆盖；增量按 updatedAt |
| `displayFinancialStatus` | `financial_status` | Pending、退款、取消均原样保留 |
| `displayFulfillmentStatus` | `fulfillment_status` | 不转换成 ERP 库存动作 |
| MoneyBag | `*_amount` + `*_minor` + `currency` | decimal 字符串精确保留；可确认币种精度时同时存最小单位 |
| `LineItem.id` | `source_order_line_id` | 订单行独立唯一；原始 SKU 和标准化 SKU 双轨 |
| `Refund.id` | `platform_refunds` | 退款对象独立保存 |
| `Refund.transactions` | `platform_order_transactions` | 成功/失败交易均保留，禁止与退款对象金额双计 |
| `Fulfillment.id` | `platform_fulfillments` | 一单可有多个履约 |
| `trackingInfo` | `platform_fulfillment_tracking` | 按追踪号/URL/稳定哈希识别，不把数组序号当永久身份 |
| 完整响应 | `platform_order_snapshots` | 按 raw hash 追加；完全相同响应不重复快照 |

未知字段保持 `null`；只有上游明确返回零时才保存 0。测试单、取消单、零金额单、Pending 单和深圳归属商品都不会在采集层删除。

## 4. 同步流程

1. 管理员调用 `POST /api/connectors/shopify/sync`。
2. 连接器取得或使用 ERP 独立凭证，只读查询 Shop 身份与 scope。
3. 首次回补必须明确 `from/to`；页面默认由管理员确认后回补最近 7 天。
4. 外层按 `updated_at` 固定时间窗口完整分页；逐订单补齐所有内层分页。
5. 完整订单图校验后才写一个 D1 batch；某订单失败不会覆盖旧有效版本。
6. 一页全部订单成功后才保存下一页游标；整窗成功后才推进 completed watermark。
7. 后续增量从水位前 6 小时重扫，依靠唯一键和 raw hash 幂等去重。
8. 同店已有任务运行时返回冲突；租约过期接管后，旧任务因 run ID 校验无法再改游标、水位或写入较旧订单版本。

状态查询：`GET /api/connectors/shopify/status`。接口只返回“是否已配置”等状态，不返回任何秘密。

## 5. 已验证结果

本地使用临时 D1 和模拟的官方 GraphQL 响应完成验证：

- 6 个 Shopify GraphQL 操作全部通过官方 `2026-07` schema validator；
- 外层订单两页；
- 订单行第二页；
- 退款行第二页；
- 退款交易第二页；
- 履约行第二页；
- Pending、取消、零金额、测试标识、部分退款、失败退款交易和多包裹；
- 相同订单重复运行：订单、行、退款、履约和快照计数不增加；
- 同一订单后续更新：更新当前事实，仅新增不同 raw hash 的快照；
- 同店并发运行被拒绝，租约接管后旧任务不能覆盖新断点；
- 外层重复游标被识别并停止；较旧 `updatedAt` 响应不能覆盖已保存的新版本；
- 顶层退款、履约或追踪数组达到读取上限时停止写入，避免静默截断；
- 失败后保留已写事实和下一页断点，completed watermark 不推进；
- 原始币种、原始 SKU、原始时间、店铺业务日和未知值可追溯。

运行命令：

```powershell
npm test
npx tsc --noEmit
npm run build
```

## 6. 真实首店试采所缺授权

四家 Shopify 均缺 ERP 独立凭证，不能复用 MUKU 看板凭证：

| 店铺 | 待核验域名 | 密钥前缀 | 还需要业务方提供/确认 |
|---|---|---|---|
| ZIMASYA | `346c85.myshopify.com` | `SHOPIFY_ZIMASYA` | 正式域名、Shop GID、ERP 独立 Token 或 client credentials、`read_orders` |
| Kaguyasu | `officebaseca.myshopify.com` | `SHOPIFY_KAGUYASU` | 同上，必须独立授权 |
| Anzhap | `anzhap.myshopify.com` | `SHOPIFY_ANZ` | 同上，必须独立授权 |
| BizFurniz | `bizfurniz.myshopify.com` | `SHOPIFY_BIZFURNIZ` | 还需确认历史域名 `z6w01w-xs.myshopify.com` 与当前店的官方 Shop ID 关系 |

基础订单需要 `read_orders`。超过最近 60 天的历史回补还需 `read_all_orders` 资格。当前详情查询涉及履约行，实际安装还应核对适用的 fulfillment-order 只读 scope。第一阶段不读取姓名、邮箱、电话或收货地址，因此不要求受保护客户数据；将来需要这些字段时必须另行申请并增加 ERP 访问控制。

真实试采还需业务负责人明确：首家店、允许回补的起止日期、正式域名和预期 Shop GID。凭证只通过 Sites 后端密钥配置提供。

真实同步还必须先设置 `ERP_ALLOWED_EMAILS` 或 `ERP_ALLOWED_EMAIL_DOMAINS`。没有公司访问名单时同步接口会拒绝启动；一旦数据库已有平台店铺，名单缺失会让全部 ERP 数据接口直接拒绝访问，避免配置丢失后恢复为公开读取。全新数据库应先只填精确 owner 邮箱，确认该 owner 已初始化为 admin 后再按需要扩大到公司域名。启动真实同步的人每次都必须同时是 admin 且命中 `ERP_ALLOWED_EMAILS` 精确邮箱；公司域名仅提供普通访问，不能单独取得同步权限。

## 7. 当前发布状态

本次只完成并验证了当前 ERP 源码，没有发布远端版本。当前源码的 Sites 配置指向受限站点 `https://yicang-erp.champztj.chatgpt.site/`，而业务正在查看的是 `https://yicang-erp-public.snappy-llama-6202.chatgpt.site/`；后者的项目在当前 Sites 工作区不可见。直接发布会更新错误站点，因此必须先恢复公共 Site 的项目归属，或明确决定把真实订单版部署到受限站点。两个站点的 D1 不能混用。

## 8. 其他平台缺口与顺序

1. 其余 Shopify 店：复用同一连接器，每店独立凭证和官方身份。
2. Amazon：四店均缺 Seller ID、Marketplace ID、ERP SP-API 应用/卖家授权；正式主来源使用当前 Orders API，浏览器/领星 sid/广告 profileId 不能替代。
3. Wayfair-林和：缺 Supplier ID、Developer Portal 应用和生产订单权限；PO/Settled/WSP 仅用于历史回补或对账。
4. 运去哪：库存、出库、入库列表、入库详情、新旧轨迹分别核验 API Key、IP 白名单、仓库范围和字段契约；不能假定同一 Key 通用。

已观察的运去哪仓码仍只是候选：`BCF_CA_US`、`BLL_NJ_US`、`CMP_GA_US`、`CPF_CA_US`、`DAO_CA_US`、`NJC_NJ_US`、`SAA_GA_US`。`BLL_NJ -> BLL_NJ_US` 未验证，不自动合并。

## 9. 官方能力核验

- Shopify Orders、分页和 updated_at：<https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders>
- Shopify access scopes：<https://shopify.dev/docs/api/usage/access-scopes>
- Amazon SP-API Orders：<https://developer-docs.amazon.com/sp-api/docs/orders-api>
- Wayfair 官方订单/库存 API 或 EDI：<https://sell.wayfair.com/operate-manage-orders>
- 运去哪文档入口：<https://open-hwc.yqn.com/apiDocs>（当前读取工具无法直接核验页面内容，实施前须在授权环境复核）

MUKU 的 GET 查询只保留为后续同日期、同币种、同业务归属范围的辅助对账。没有调用其写入、同步、部署或管理接口。
