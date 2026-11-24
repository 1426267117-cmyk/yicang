# 易仓 ERP 自研项目

这是 MUKU 内部自研的跨境电商 ERP 工程。当前代码覆盖 Shopify 订单只读接入、MUKU 库存只读同步、运营订单、库存账本和采购业务闭环。

## 当前进度

- 采购模块已具备采购建议、SKU 映射、采购申请、复审、采购单、分批到货、冲正和审计能力。
- Shopify 已完成四店连接器框架。BizFurniz 已通过真实订单同步验收，其余三店仍需安装授权和真实数据核验。
- MUKU 库存、库存明细、库存风险和来源状态通过只读接口进入 ERP 独立快照。
- 仓库作业、物流、财务和报表仍处于后续开发阶段。

更详细的采购交付状态见 `docs/PROCUREMENT_GO_LIVE_CHECKLIST_20261102.md`，多店接入状态见 `docs/SHOPIFY_MULTI_STORE_ROLLOUT_20261102.md`。

## 本地运行

要求 Node.js 22.13 或更高版本。

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

浏览器访问 `http://localhost:3000/`。

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

## 数据保护

MUKU 看板、采集任务、共享盘和 UNC 路径中的原始数据均为外部只读来源。ERP 只保存自己的业务数据和只读快照。
