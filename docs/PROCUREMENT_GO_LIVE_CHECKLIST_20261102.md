# 采购模块交付与上线清单（2026-11-02）

## 当前可交付状态

- 本地源码已完成采购闭环：官方订单需求、SKU 映射、库存安全门、采购建议、申请/复审、正式采购单、分批到货、短到关闭、错录冲正、历史审计和在途负责人交接。
- 本地数据库已备份后追加应用 `0014`、`0015`、`0016` 迁移；原有采购申请、采购单和到货记录保留，未删除或覆盖业务数据。
- 采购验收套件 62 项通过；全项目 44 个测试文件、304 项测试通过；TypeScript、ESLint 和生产构建通过。
- Shopify 当前仍是 BizFurniz 单店试点（1/4）。该店已用官方 API 保存过 9 个真实订单事实，并验证过增量同步重复运行不重复入库。页面必须继续显示真实覆盖数，不能把单店试点称为全店覆盖。
- MUKU 仅以只读方式用于库存辅助与对账；本次未修改 MUKU 看板、采集任务、共享盘或其凭证。

## 采购部门试用顺序

1. 打开“采购管理 → 今日采购建议”，先确认 Shopify 官方订单源和 MUKU 库存均显示可用于采购。
2. 处理待映射 SKU；未知库存保持阻断，只有实际核验后才可录入有时效的人工库存确认。
3. 从无阻断的真实订单缺口生成采购申请，指定采购负责人和复审人。
4. 完成提交、复审；由负责人选择供应商、固定收货仓、预计交期、币种和全部行单价后生成采购单。
5. 确认已发给供应商后“确认下单”；到货时只能进入采购单固定仓，支持分批登记。
6. 错录使用“冲正错录”，供应商短交使用“关闭剩余量”；不要修改、删除或重建历史记录。
7. 人员换班或离岗时由管理员点“重新指派”；已有在途采购单的操作权同步转给新负责人并留下原因与审计。

详细操作见 [采购部门使用与验收手册](./PROCUREMENT_DEPARTMENT_HANDOFF.md)。

## 发布时一次性完成

1. 由能够访问 Sites 项目 `appgprj_6a9662cdd4ec8191913b81ebafb17ee6` 的项目所有者账号发布当前代码；当前登录账号看不到该项目，因此当前线上站点仍不是这次完整采购交付版本。
2. 发布流程只向生产 D1 应用尚未执行的追加迁移，至少核对 `0014` 至 `0016`；不得重建、清空、覆盖或替换生产数据库。发布后 `/api/health` 必须返回数据库就绪。
3. 开发试用阶段保留 `ERP_DEV_OPEN_ACCESS=true`，方便不同 GPT 账号继续操作；正式上线前改为 `false`，配置正式 owner/名单并让采购成员各登录一次后分配角色。
4. 保留 ERP 独立的 MUKU 只读 Secret、Shopify 凭证加密密钥和内部任务密钥。Secret 不写入 Git、页面、聊天或任务提示词。
5. 发布后注册 Shopify Webhook，并配置约 15 分钟一次的受保护增量对账与 MUKU 刷新；只有真实调度验证成功后才能把页面标记为自动化闭环。
6. 用经批准的小额或非生产申请走完一次：建议 → 申请 → 复审 → 采购单 → 下单 → 分批到货 → 日终核对。

## 明天必须由店铺侧完成的事项

当前代码已具备四店隔离配置和统一 OAuth/同步/Webhook 能力，但下面三店没有独立应用凭证和店主安装授权，ERP 不能代替店主授权：

| 店铺 | 当前缺项 | 完成后 ERP 自动继续的工作 |
| --- | --- | --- |
| ZIMASYA | 对应店铺的应用 Client ID/Secret、店主安装授权 | 核验官方 Shop ID，回补订单，验证分页/幂等，再启用增量与 Webhook |
| Kaguyasu | 对应店铺的应用 Client ID/Secret、店主安装授权 | 同上 |
| Anzhap | 对应店铺的应用 Client ID/Secret、店主安装授权 | 同上 |

每个生产店都必须单独完成官方授权并获得自己的离线访问令牌。Custom distribution 通常只能装到一个生产店；只有同一 Shopify Plus organization 的多店例外。若四店不属于同一 Plus organization，应为每店建立独立 custom app，或另走经过审核的 public distribution。订单默认只有最近 60 天；更早历史还需 `read_all_orders`，且它必须与 `read_orders` 搭配。

官方依据：

- [Shopify app distribution](https://shopify.dev/docs/apps/launch/distribution)
- [Shopify API access scopes / orders permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)
- [Shopify GraphQL Admin Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)

## 不属于本次可自动完成的阻断

- 当前 GPT/Sites 账号无目标 Sites 项目发布权；需要项目所有者账号完成发布，代码本身已准备好。
- 三家未授权店铺必须由相应店主完成 Shopify 安装授权；授权前不能合法读取真实订单。
- `read_all_orders`、受保护客户数据或任何写订单/库存/付款/发货权限都需要按实际业务另行授权。本次采购试点只使用订单只读能力，不反写店铺。

