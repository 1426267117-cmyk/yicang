# Shopify 三店应用创建记录（2026-11-11）

## 已完成的外部配置

用户已明确确认创建三个应用及其各自单店安装链接。在 Shopify Dev Dashboard 组织 `232970693` 下完成：

| ERP storeKey | 应用 | App ID | 有效版本 ID | 自定义安装目标 |
| --- | --- | --- | --- | --- |
| zimasya | MUKU ERP ZIMASYA Order Sync | 446091329537 | 1203089965057 | 346c85.myshopify.com |
| kaguyasu | MUKU ERP Kaguyasu Order Sync | 446091657217 | 1203091013633 | officebaseca.myshopify.com |
| anzhap | MUKU ERP Anzhap Order Sync | 446091755521 | 1203091210241 | anzhap.myshopify.com |

三个应用均使用版本名 `v1-readonly-orders`，Webhook API 版本 `2026-10`，关闭 Shopify 后台嵌入。应用 URL 为 `https://yicang-erp.champztj.chatgpt.site`。

权限范围与既有 BizFurniz 应用保持一致：

```text
read_orders,read_assigned_fulfillment_orders,read_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders
```

回调 URL 分别为：

- `https://yicang-erp.champztj.chatgpt.site/api/connectors/shopify/oauth/zimasya/callback`
- `https://yicang-erp.champztj.chatgpt.site/api/connectors/shopify/oauth/kaguyasu/callback`
- `https://yicang-erp.champztj.chatgpt.site/api/connectors/shopify/oauth/anzhap/callback`

已为三个应用选择自定义分发并生成各自单店链接，未启用 Plus 多店安装。签名安装链接可从对应应用的分发页重新取得，本文件不保存签名链接或任何秘密值。

应用列表核实：三家新应用均存在，安装数均为 0。创建成功不代表已获得店铺订单 API 授权。

## 当前生产阻塞

Sites 项目 ID：`appgprj_6a9662cdd4ec8191913b81ebafb17ee6`。公开项目元数据仍显示生产版本 19、地址 `https://yicang-erp.champztj.chatgpt.site`；当前账号/工作区调用 `get_environment_variables` 返回 `Sites project not found`（NOT_FOUND）。因此未尝试写入环境变量或部署。

本次未读取、复制、展示新应用 Client Secret；未进行店铺安装授权或新增真实订单同步。需由能管理该 Sites 项目的账号/工作区继续完成后端配置。

## 后续同一批处理

1. 确认 Sites 后端配置和发布权限。
2. 将三店独立 OAuth 凭据安全配置到 Sites 后端；所需键为 `SHOPIFY_ZIMASYA_CLIENT_ID/CLIENT_SECRET`、`SHOPIFY_KAGUYASU_CLIENT_ID/CLIENT_SECRET`、`SHOPIFY_ANZ_CLIENT_ID/CLIENT_SECRET`，可显式设置对应 `_SHOP_DOMAIN`。不得把秘密写入本文件、源码、日志或浏览器前端。
3. 部署现有已保存版本以应用新的环境变量修订，再逐店完成只读安装授权和 ERP OAuth 回调。安装前核对应用、目标店铺和只读权限；如需要用户授权，将三家合并说明。
4. 验证 `/api/connectors/shopify/status` 店铺身份与凭证状态；固定日期范围回补、重复运行、增量同步，报告真实结果。未获授权前不得把测试通过描述为店铺已接通。

本地连接器已支持三店，无需另建模型或连接器。只读审计确认工作树起始为 clean，HEAD 为 `480dc7f`。针对多店隔离、分页、幂等/增量、断点恢复、失败保留有效数据及凭证存储的 4 个测试文件共 13 项通过；这是本地测试，不是三店真实 API 验收。

## 数据保护

本次只创建 Shopify 应用及安装链接，并新增 ERP 内的交接记录/截图。未改动既有 BizFurniz 应用、MUKU 看板、采集任务、共享盘或 UNC 原始数据；没有删除任何内容。

截图仅在本机留存，迁移到公开源码仓库时不上传。

## 同日后续：当前账号编辑授权已完成

用户明确要求沿用 Chrome 中已登录的所有者账号，向当前开发账号授权，不切换桌面账号。

通过 Chrome 的官方 Sites 共享界面，已将该账号添加为“编辑者”，保留所有者及既有公开访问设置。原生 `get_site` 已确认当前账号 `current_user_role=editor`，且 `list_site_versions` 已成功读取版本 19。

编辑者账号的 `get_environment_variables` 再次核验仍返回 `NOT_FOUND`，不能据此声称密钥配置权限也已开放。Chrome 中已核实所有者的官方站点设置页有环境变量配置入口，后续可沿用这个独立浏览器会话处理所有者操作，无需切换桌面账号。

此次只新增编辑授权并检查官方设置入口，未读取或复制三店 Client Secret，未更改任何环境变量、未部署、未安装三店应用。安装和真实同步状态仍为待完成。

授权截图仅在本机留存，迁移到公开源码仓库时不上传。
