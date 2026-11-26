# 易仓 ERP 自研项目

这是 MUKU 内部自研的跨境电商 ERP 工程，覆盖平台订单、采购、仓库、物流、财务和数据报表。每家公司使用独立数据库与接入配置。

## 当前进度

- 采购模块支持独立 SKU 建档和手工采购申请，也支持由采购建议生成申请。两类申请都可以走复审、采购单、分批到货、冲正和审计。
- 采购可维护供应商多币种阶梯报价，采购草稿按供应商、SKU、件数和币种显式带价。采购单可在首次入库前启用到货质检，仓库按批次登记合格及不合格件数，按质检放行额度入库。
- 运营工作台展示待审核、待发货、待收货和低库存。渠道订单查平台已接收的数据，仓库和财务使用 ERP 业务账本。
- 飞书用于开账前导入或管理员补录。历史订单、退款、采购与分仓资料在「系统管理 → 期初导入」查询。导入变更保留历史版本，日常采购和库存以正式业务单据为依据。见 [期初导入](docs/FEISHU_OPENING_IMPORT.md)。
- Shopify 支持四店独立授权、首轮回补、Webhook 和计划增量对账。店铺接入显示当前工作区授权和最近同步，按店铺与 SKU 可读取 Shopify 各库位库存。平台写回和实际店铺运行需分别验收。见 [Shopify 自动同步](docs/SHOPIFY_REALTIME_WEBHOOK.md)。
- Amazon 四店支持 SP-API 只读订单接入、逐店核验和断点续传。授权店铺在店铺接入选定首轮回补日期，订单和 SKU 明细进入渠道订单。现网状态以店铺接入的实际同步结果为准。见 [Amazon 订单接入](docs/AMAZON_ORDER_SYNC.md)。
- MUKU 库存、库存明细、库存风险和来源状态通过只读接口进入 ERP 独立快照。
- 仓库工作台处理采购收货和冲正、出库拣货与复核打包、库存盘点和库存查询。收货增加账面库存，审核产生预占，发货减少库存，取消释放预占。
- 物流支持为 ERP 出库订单登记多个包裹，记录运输异常和签收，查看已接收的平台履约数据。
- 财务管理员可按采购单登记发票和实际付款，冲正错录，按原币核对合同、收货、开票和付款金额。
- 采购员可按采购单和原币发起预付款或尾款申请，由另一位管理员审批。财务可将已登记的实付关联到请款单，冲正后按净实付显示。
- 数据报表可查询并导出订单、采购和库存。平台结算、承运商接口和银行流水需要对应来源授权。

更详细的采购交付状态见 `docs/PROCUREMENT_GO_LIVE_CHECKLIST_20261102.md`，多店接入状态见 `docs/SHOPIFY_MULTI_STORE_ROLLOUT_20261102.md`。

## 广州九店验收范围

- 亚马逊四店为森语、Kaguyasu、中诚、Genji。独立站四店为 Kaguyasu、ZIMASYA、Anzhap、BizFurniz。Wayfair 为林和店。亚马逊和独立站的同名店使用不同店铺键。
- 对每店核对来源身份、数据时效、订单和 SKU 明细、退款、履约状态及覆盖缺口。订单号按渠道和店铺区分。允许飞书订单按来源事实先入档，平台直连和发货回传各自逐店验收。
- 店铺授权、归属规则和业务数据保留在各公司自己的运行环境。当前飞书数据保留为期初资料，日常订单接入按平台接口逐店验证。

## 本地运行

要求 Node.js 22.13 或更高版本。

```powershell
npm install
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
npx wrangler d1 migrations apply site-creator-d1 --local --config db/local-wrangler.jsonc --persist-to .wrangler/state
npm run dev
```

浏览器访问 `http://127.0.0.1:3000/`。

`.env.local` 只用于本机，已经被 Git 忽略。根据 `.env.example` 配置 ERP 自己的后端密钥。不要把 Token、Cookie、Client Secret 或真实 API Key 写入源码。

## 验证

```powershell
npm run lint
npm run test:procurement-acceptance
npm run build
```

本机若出现 Miniflare `EADDRINUSE`，应先排查 Windows 临时端口占用后再运行验收套件。该错误发生在测试数据库启动阶段。

## 数据库与部署

- 数据模型使用 Drizzle，迁移文件位于 `drizzle/`。
- 本地开发使用 Cloudflare Worker 和 D1 模拟环境。
- `dist/`、`.wrangler/`、本地数据库、运行缓存和截图证据不会进入仓库。
- 生产数据库、生产密钥和 MUKU 原始数据不包含在本仓库中。

部署到新的 Cloudflare Workers + D1 环境时，应创建独立 D1 数据库、执行现有迁移、配置后端 Secrets，并更新 Shopify OAuth 回调地址和 Webhook 地址。

使用 AWS 独立部署时，按公司分别发布同一套代码，在各自的服务器和数据卷上运行。部署方式见 [AWS 部署手册](deploy/aws/README.md)。

## 数据保护

MUKU 看板、采集任务、共享盘和 UNC 路径中的原始数据均为外部只读来源。ERP 只保存自己的业务数据和只读快照。
