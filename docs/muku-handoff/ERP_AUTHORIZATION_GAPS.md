# ERP 平台授权与身份缺口

本清单只描述 ERP 独立接入所缺内容。不得复用、导出或改动 MUKU 看板现有凭证。

## Shopify

每店均需：确认正式 `myshopify.com` 域名和 Shop GID；提供 ERP 专用 Admin API access token 或 client credentials；至少授予 `read_orders`；超过最近 60 天需 `read_all_orders` 资格；读取履约行时核验该店适用的 fulfillment-order 只读 scope。第一阶段不读取客户 PII；以后需要姓名、邮箱、电话或地址时另行申请受保护客户数据权限。

| 店铺 | 看板标识 | 待核验域名 | ERP 密钥前缀 | 特别缺口 |
|---|---|---|---|---|
| ZIMASYA | `zimasya` | `346c85.myshopify.com` | `SHOPIFY_ZIMASYA` | Shop GID、独立授权、允许回补最早日期 |
| Kaguyasu | `kaguyasu` | `officebaseca.myshopify.com` | `SHOPIFY_KAGUYASU` | Shop GID、独立授权、允许回补最早日期 |
| Anzhap | `anzhap` | `anzhap.myshopify.com` | `SHOPIFY_ANZ` | Shop GID、独立授权、允许回补最早日期 |
| BizFurniz | `bizfurniz` | `bizfurniz.myshopify.com` | `SHOPIFY_BIZFURNIZ` | 先用 Shop GID 核验历史域名 `z6w01w-xs.myshopify.com` 是否同店，禁止按名称合并 |

## Amazon SP-API

以下四店均缺 Seller ID、Marketplace ID、ERP 自有 SP-API 应用和卖家正式授权，以及当前 Orders API 所需角色。需要地址等 PII 时还要核验受限数据流程。领星 sid、广告 profileId、浏览器会话都不是正式 Seller ID 或授权。

| 店铺 | 看板标识 | 当前仅知 | 缺少 |
|---|---|---|---|
| genji furniture-US | `genji` | 美国站提示 | Seller ID、Marketplace ID、应用/卖家授权、Orders 角色 |
| kaguyasu-US | `kagu` | 美国站提示 | 同上，必须单独核验 |
| senyujp-US | `senyu` | 美国站提示 | 同上，必须单独核验 |
| Zhongcheng / 中诚 | `zhongcheng` | 美国站提示 | 同上，必须单独核验 |

正式开发使用当前官方 SP-API Orders 版本；旧 Orders v0 的字段、RDT 和限流参数不能照搬。

## Wayfair-林和

- 看板标识：`guangzhoulinhemuyukejiyoungxs`
- 缺少：正式 Supplier ID、标识对应关系确认、Developer Portal 应用、ERP 独立生产凭证、订单生产读取权限、历史范围/分页/限流契约。
- 还需确认订单、行、取消、退货、退款和履约实际可取得字段；若 API 暂不可用，再确认正式 EDI。
- PO CSV、Settled 扣款和 WSP 广告仅作历史回补或对账；浏览器会话不是长期订单连接器。

## 运去哪

同一 Key 不能推定拥有全部能力，每个接口独立核验：

| 资源 | 参考路径 | 缺少/待核验 |
|---|---|---|
| 库存分页 | `/v2/inventory/get_inventory_by_page` | 生产 Base URL/API Key、IP 白名单、仓库范围、数量字段定义、分页上限 |
| 出库单 | `/v1/saleOrder/findByPage` | 出库权限、仓库范围、日期/时区、历史窗口、源单号字段语义、状态枚举 |
| 入库计划列表 | `/v1/inbound/findByPage` | 列表权限、日期/时区、历史范围、分页上限、稳定业务键 |
| 入库计划明细 | `/v1/inbound/getInboundPlanInfo` | 明细权限、`orderNo` 契约、SKU/计划/装箱/收货字段、并发限流 |
| 新版运输轨迹 | `ship-api.yqn.com/api/v2/orderShipment/track/{trackingNo}` | 独立生产权限、Key 关系、节点/状态/更新时间、限流重试 |
| 旧版运输轨迹 | `/v1/truck/track/details` | 是否仍受支持、独立 Key/IP、新旧字段映射及允许回退条件 |

已观察仓码 `BCF_CA_US`、`BLL_NJ_US`、`CMP_GA_US`、`CPF_CA_US`、`DAO_CA_US`、`NJC_NJ_US`、`SAA_GA_US` 只表示原项目曾见到，不证明 ERP 凭证有权限。`BLL_NJ -> BLL_NJ_US` 仍未验证，不自动合并。

## 业务方需要完成的最小动作

1. 明确真实订单部署到受限站还是公共站；公共站项目当前不在已连接 Sites 工作区中，不能误发到另一个 D1。
2. 先用精确 owner 邮箱配置 `ERP_ALLOWED_EMAILS`，确认 owner 已初始化为 admin 后再按需增加 `ERP_ALLOWED_EMAIL_DOMAINS`；真实同步操作者必须始终保留在精确邮箱名单中，公司域名不能单独授予同步权限；公共演示站不配置真实凭证。
3. 明确首家 Shopify 店及允许试采的日期范围。
4. 提供正式域名和预期 Shop GID。
5. 在正确 ERP Site 的后端密钥中配置该店独立只读凭证，不通过聊天或源码传递。
6. 确认授予的 scope；历史超过 60 天时确认 `read_all_orders`。
7. 首次同步后提供同日期范围的平台订单导出或后台核对权限，以便逐笔验收。
