# Wayfair 林和采购单预览

在「店铺接入」里选择供应商确认状态，可读取近 30 天内订单创建的 Wayfair 采购单。每次最多返回 25 单，达到上限时页面提示可能还有其他记录。供应商已确认属于 Wayfair 采购单确认状态。预览会显示采购单号、创建时间、供应商 SKU、Wayfair SKU、商品、数量和已返回的取消标记。结果仅保留在当前页面。

Wayfair 当前公开的 Dropship Orders API 指定 `getDropshipPurchaseOrders`。查询范围使用 `hasResponse` 和 `fromDate`，官方合同未给出可用于完整订单增量同步的分页游标或最后更新时间。该接口适合有界的采购单查询。EDI 是独立接入选项。 [Wayfair 订单接入说明](https://sell.wayfair.com/operate-manage-orders) · [Wayfair Dropship 订单指南](https://developer.wayfair.io/posts/dropship-orders-asn) · [GraphQL 规范](https://developer.wayfair.io/posts/docs/orders-api/reference/GraphQL/v1.0.0)

## 服务端配置

Wayfair Partner Home 的账户管理员应先为操作账号开通 `API` 角色。在 Wayfair Developer Portal 创建应用并完成规定的沙箱验证，再创建正式应用。凭证放在部署服务器的私有运行环境配置中。 [Wayfair 接入流程](https://developer.wayfair.io/posts/introduction) · [API 令牌](https://developer.wayfair.io/posts/api-access-tokens)

| 环境变量 | 取值 |
| --- | --- |
| `ERP_WAYFAIR_LINHE_TENANT_ID` | 广州 ERP 工作区的内部标识 |
| `ERP_WAYFAIR_LINHE_ENVIRONMENT` | `sandbox` 或 `production` |
| `ERP_WAYFAIR_LINHE_SUPPLIER_IDS` | 已确认属于林和的 Wayfair 供应商或授权子仓供应商 ID，多个用逗号分隔 |
| `ERP_WAYFAIR_LINHE_CLIENT_ID` | 对应环境的林和应用 Client ID |
| `ERP_WAYFAIR_LINHE_CLIENT_SECRET` | 对应环境的林和应用 Client Secret |
| `ERP_WAYFAIR_LINHE_VERIFY_PO_NUMBER` | 从同一环境、同一供应商账号确认的完整 PO 编号 |
| `ERP_WAYFAIR_LINHE_VERIFY_HAS_RESPONSE` | 该核验单已确认填 `true`，未确认填 `false` |

有接入读取权限的成员可查看配置状态。有接入操作权限的管理员可读取预览。使用正式环境时，管理员邮箱还须列在现有的 `ERP_ALLOWED_EMAILS` 中。每次预览先用指定 PO 核验授权及供应商 ID，再读取所选范围。核验订单的确认状态发生变化时，更新服务端的核验配置。
