# MUKU 看板只读接入说明

## 边界

- ERP 只调用 MUKU 的 `GET /api/integrations/erp/v1/export`。
- MUKU 看板、采集任务、数据库、共享盘原始文件和已有授权均保持不变。
- API Key 只通过后端环境变量 `MUKU_DASHBOARD_API_KEY` 提供；不得使用 `NEXT_PUBLIC_` 前缀，也不得写入浏览器代码、日志或 Git。
- MUKU 数据保存到 ERP 独立的只读快照表，不覆盖 ERP 的订单、库存账本、采购单或收货结果。

## 当前数据链路

```text
MUKU 只读出口
  -> ERP 后端连接器（鉴权、超时、限流重试、完整分页）
  -> ERP 独立快照（旧快照保留，完整新快照成功后才切换）
  -> 库存页中的“MUKU 只读库存 / 库存风险”
```

当前落库数据集：

| 数据集 | ERP 用途 | 是否改业务库存 |
| --- | --- | --- |
| `inventory` | 跨仓 SKU 库存参考与采购判断 | 否 |
| `inventory-details` | 箱/批次/库龄等明细追溯 | 否 |
| `inventory-risk` | 低库存、超龄、滞销风险提示 | 否 |
| `source-status` | 数据源新鲜度、异常和延迟说明 | 否 |

MUKU 清单中其余数据集已识别，后续按业务阶段接入：履约单、库存日快照、Shopify 日汇总与财务、Shopify SKU 30 日、渠道日汇总、店铺状态、渠道报表运行状态。

## 数据规则

- `null` 表示未知或未提供，界面显示“未知”，不能改成 `0`。
- 库存业务时区按源数据元信息保存，当前主要为 `Asia/Shanghai`；Shopify/渠道业务日期主要按 `America/Los_Angeles`。
- 金额分析以 `shopify-finance` 为主，普通日汇总只用于辅助分析和对账。
- 每次同步先拉完全部分页并校验记录数，再切换有效快照；空数据、分页不完整、鉴权失败或网络失败都不替换上一份有效快照。
- 重复同步通过幂等键和内容哈希防重，不重复生成同一业务结果。

## 本地配置与验证

1. 在 `.env.local` 或部署平台的后端 Secret 中设置：
   - `MUKU_DASHBOARD_BASE_URL`
   - `MUKU_DASHBOARD_API_KEY`
2. 启动 ERP 后，在库存页点击“测试连接”。
3. 测试成功后点击“同步 MUKU 只读数据”。
4. 在“MUKU 只读库存”和“库存风险”页签核对记录数、数据时间、时区和来源状态。

部署环境需要单独配置相同名称的 Secret；本地 `.env.local` 不会自动上传，也不得提交到 Git。
