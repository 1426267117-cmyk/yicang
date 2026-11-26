# Amazon 订单接入

广州的固定店铺键为 `amazon-senyu`、`amazon-kaguyasu`、`amazon-zhongcheng` 和 `amazon-genji`。易仓通过 SP-API Orders v2026-01-01 读取订单和商品行。每家店保留独立的订单唯一键、最后一次完成的同步窗口和失败断点。 [Amazon Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api)

## 配置与首轮核验

1. 在该公司的服务器密钥配置中设定 `ERP_AMAZON_ORDERS_TENANT_ID`。Lightsail 单工作区使用 `tenant_yicang_primary`，各公司使用各自的服务器和密钥。填写 `ERP_AMAZON_CLIENT_ID`、`ERP_AMAZON_CLIENT_SECRET`。若各店采用不同 SP-API 应用，可通过单店前缀的 `_CLIENT_ID` 和 `_CLIENT_SECRET` 提供该店专用值。
2. 按 `.env.example` 配置每家店的卖家 ID、站点 ID、Refresh Token 和该店的一笔核验单号。核验单必须从对应卖家后台确认。Orders API 通过该授权能否读取指定订单和返回正确站点提供核验依据，卖家 ID 来自部署配置。同一 Refresh Token、卖家 ID 或核验单号在多个店铺重复时，相关店铺停止同步。 [Amazon 应用授权](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)
3. 在「店铺接入 → Amazon 四店」逐店执行首次同步。回补按订单更新时间，每个窗口最多 30 天，结束时间保留平台要求的两分钟间隔。状态显示「分页待继续」时继续原窗口。只有读取并保存全部分页之后，页面的「已覆盖至」才会更新。
4. 打开「渠道订单」按对应店铺和实际订单号回查，核对商品项、状态和平台更新时间。首次回补起始日之前的历史仍以可核实的期初资料为准。

## Lightsail 后台执行

店铺授权和首次回补验收后，在应用的服务端环境设定 `ERP_AMAZON_RECONCILE_ENABLED=true`。定时任务与现有 Shopify 作业共用同一份内部 ERP 作业密钥配置 `/etc/yicang/shopify-jobs.env`。作业只访问本机回环端口，Amazon 请求由 ERP 服务发出。使用发布包中的单元文件启用定时器，每次间隔约 30 分钟。

```bash
sudo install -m 0644 /opt/yicang/current/deploy/lightsail/yicang-amazon-orders.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start yicang-amazon-orders.service
sudo systemctl enable --now yicang-amazon-orders.timer
sudo journalctl -u yicang-amazon-orders.service -n 10 --no-pager
```

日志只显示店铺与订单计数。后台使用同一套分页断点和去重逻辑，某店同步失败会保留已有订单，其他店继续独立运行。订单数据中未请求买家、收件人、退款账本或库存，销售与采购的实际业务操作仍以现有 ERP 单据为依据。
