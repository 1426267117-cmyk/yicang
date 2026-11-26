'use client';

import { useRef, useState } from 'react';
import {
  calculateFeishuPilot,
  FEISHU_PILOT_LIMIT,
  FEISHU_PILOT_MAX_DAYS,
  type FeishuPilotCandidate,
  type FeishuPilotPurchaseContext,
} from '../lib/feishu-replenishment-pilot';

type PilotLine = { sku: string; lead: string; safety: string; inboundConfirmation: string | null };
type PilotCalculation = NonNullable<ReturnType<typeof calculateFeishuPilot>>;
type PrepareRequest = (sku: string, quantity: number, basis: string) => void | Promise<void>;

const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
const maxRequestQuantity = 100_000_000;

function parseDays(value: string, minimum: number) {
  if (!value.trim()) return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= minimum && days <= FEISHU_PILOT_MAX_DAYS ? days : null;
}

function requestBasis(candidate: FeishuPilotCandidate, snapshotDate: string, leadDays: number, safetyDays: number, result: PilotCalculation) {
  return `广州补货试算 · ${candidate.sku} · 飞书 ${snapshotDate} 快照。已核销量 ${amount.format(candidate.verifiedSales)} 件，日均估算 ${amount.format(candidate.dailySales)} 件，三仓可用 ${amount.format(candidate.availableQty)} 件。实际交期 ${leadDays} 天，安全库存 ${safetyDays} 天，目标 ${amount.format(result.targetQty)} 件。截至 ${result.cutoffDate} 交期内在途 ${amount.format(result.eligibleInboundQty)} 件，计入 ${amount.format(result.countedInboundQty)} 件。建议采购 ${amount.format(result.recommendedQty)} 件。`;
}

export default function FeishuReplenishmentPilot({ candidates, snapshotDate, purchaseContext, onPrepareRequest }: {
  candidates: FeishuPilotCandidate[];
  snapshotDate: string;
  purchaseContext: Record<string, FeishuPilotPurchaseContext>;
  onPrepareRequest?: PrepareRequest;
}) {
  const [lines, setLines] = useState<PilotLine[]>([]);
  const [selection, setSelection] = useState('');
  const [preparingSku, setPreparingSku] = useState<string | null>(null);
  const activePreparation = useRef(false);
  const candidateBySku = new Map(candidates.map((candidate) => [candidate.sku, candidate]));
  const selectedSkus = new Set(lines.map((line) => line.sku));
  const remaining = candidates.filter((candidate) => !selectedSkus.has(candidate.sku));
  const canAdd = lines.length < FEISHU_PILOT_LIMIT && remaining.length > 0;
  const selected = canAdd && remaining.some((candidate) => candidate.sku === selection) ? selection : '';

  function addSku() {
    if (!selected) return;
    setLines((current) => current.length >= FEISHU_PILOT_LIMIT || current.some((line) => line.sku === selected)
      ? current
      : [...current, { sku: selected, lead: '', safety: '', inboundConfirmation: null }]);
    setSelection('');
  }

  function updateLine(sku: string, changes: Partial<Omit<PilotLine, 'sku'>>) {
    setLines((current) => current.map((line) => line.sku === sku ? { ...line, ...changes } : line));
  }

  async function prepareRequest(sku: string, quantity: number, basis: string) {
    if (!onPrepareRequest || activePreparation.current) return;
    activePreparation.current = true;
    setPreparingSku(sku);
    try {
      await onPrepareRequest(sku, quantity, basis);
    } finally {
      activePreparation.current = false;
      setPreparingSku(null);
    }
  }

  return <section className="replenishment-pilot" aria-label="广州补货试算">
    <header className="replenishment-pilot-header">
      <div>
        <h3>广州补货试算</h3>
        <p>按 SKU 填写实际交期和安全库存天数。建议数量供人工复核，采购仍按申请和复审流程办理。</p>
      </div>
      <span className="replenishment-pilot-count">{candidates.length} 个 SKU 可试算</span>
    </header>
    <div className="replenishment-pilot-picker">
      <label>选择试算 SKU
        <select value={selected} onChange={(event) => setSelection(event.target.value)} disabled={!canAdd}>
          <option value="">{remaining.length ? '请选择 SKU' : '暂无可添加的 SKU'}</option>
          {remaining.map((candidate) => <option key={candidate.sku} value={candidate.sku}>{candidate.sku}</option>)}
        </select>
      </label>
      <button type="button" className="secondary-button" disabled={!selected} onClick={addSku}>加入试算</button>
      <span className="replenishment-pilot-count" role="status">已选 {lines.length}/{FEISHU_PILOT_LIMIT} 个</span>
    </div>
    {candidates.length === 0 && <p className="replenishment-pilot-empty replenishment-pilot-note">暂无同时具备核定销量和三仓可用量的 SKU。</p>}
    {lines.length > 0 && <ul className="replenishment-pilot-list">
      {lines.map((line) => <PilotItem
        key={line.sku}
        line={line}
        candidate={candidateBySku.get(line.sku)}
        snapshotDate={snapshotDate}
        context={purchaseContext[line.sku]}
        onChange={(changes) => updateLine(line.sku, changes)}
        onRemove={() => setLines((current) => current.filter((item) => item.sku !== line.sku))}
        preparingSku={preparingSku}
        onPrepareRequest={onPrepareRequest ? prepareRequest : undefined}
      />)}
    </ul>}
  </section>;
}

function PilotItem({ line, candidate, snapshotDate, context, onChange, onRemove, preparingSku, onPrepareRequest }: {
  line: PilotLine;
  candidate?: FeishuPilotCandidate;
  snapshotDate: string;
  context?: FeishuPilotPurchaseContext;
  onChange: (changes: Partial<Omit<PilotLine, 'sku'>>) => void;
  onRemove: () => void;
  preparingSku: string | null;
  onPrepareRequest?: PrepareRequest;
}) {
  const [prepareError, setPrepareError] = useState('');
  const preparing = preparingSku === line.sku;
  const leadDays = parseDays(line.lead, 1);
  const safetyDays = parseDays(line.safety, 0);
  const baseline = candidate && leadDays !== null && safetyDays !== null
    ? calculateFeishuPilot(candidate, snapshotDate, leadDays, safetyDays, false)
    : null;
  const inboundKey = candidate && baseline && baseline.eligibleInboundQty > 0
    ? JSON.stringify([snapshotDate, baseline.cutoffDate, candidate.transit])
    : null;
  const countInbound = inboundKey !== null && line.inboundConfirmation === inboundKey;
  const calculation = countInbound && candidate && leadDays !== null && safetyDays !== null
    ? calculateFeishuPilot(candidate, snapshotDate, leadDays, safetyDays, true)
    : baseline;
  const hasPurchaseInProgress = Boolean(context && (context.outstanding > 0 || context.pendingRequests > 0));
  const hasInputs = Boolean(line.lead.trim() && line.safety.trim());
  const overRequestLimit = Boolean(calculation && calculation.recommendedQty > maxRequestQuantity);

  async function prepareDraft() {
    if (preparingSku || !onPrepareRequest || !candidate || !calculation || calculation.recommendedQty <= 0 || overRequestLimit || leadDays === null || safetyDays === null) return;
    setPrepareError('');
    try {
      await onPrepareRequest(line.sku, calculation.recommendedQty, requestBasis(candidate, snapshotDate, leadDays, safetyDays, calculation));
    } catch (error) {
      setPrepareError(error instanceof Error && error.message ? error.message : '暂未能带入采购申请，请重试。');
    }
  }

  return <li className="replenishment-pilot-item">
    <div className="replenishment-pilot-item-header">
      <h4>{line.sku}</h4>
      <button type="button" className="secondary-button" aria-label={`移除 ${line.sku}`} disabled={preparing} onClick={onRemove}>移除</button>
    </div>
    {candidate ? <>
      <p className="replenishment-pilot-note">
        核定销量 {amount.format(candidate.verifiedSales)} 件 · 核定店铺 {candidate.verifiedStores} 家
        {candidate.unverifiedStores > 0 && ` · 待核店铺 ${candidate.unverifiedStores} 家`}
        {candidate.heldSalesRows > 0 && ` · 销量归属待核 ${candidate.heldSalesRows} 行`}
        {' · '}核定天数 {candidate.minTrustedDays === candidate.maxTrustedDays ? candidate.minTrustedDays : `${candidate.minTrustedDays}–${candidate.maxTrustedDays}`} 天
      </p>
      <div className="replenishment-pilot-fields">
        <label>实际采购交期
          <input type="number" inputMode="numeric" min={1} max={FEISHU_PILOT_MAX_DAYS} step={1} value={line.lead}
            aria-label={`${line.sku} 实际采购交期（天）`}
            aria-invalid={Boolean(line.lead && leadDays === null)}
            disabled={preparing}
            onChange={(event) => onChange({ lead: event.target.value, inboundConfirmation: null })} /> 天
        </label>
        <label>安全库存天数
          <input type="number" inputMode="numeric" min={0} max={FEISHU_PILOT_MAX_DAYS} step={1} value={line.safety}
            aria-label={`${line.sku} 安全库存天数`}
            aria-invalid={Boolean(line.safety && safetyDays === null)}
            disabled={preparing}
            onChange={(event) => onChange({ safety: event.target.value })} /> 天
        </label>
      </div>
      <dl className="replenishment-pilot-stats">
        <div><dt>日均销量估算</dt><dd>{amount.format(candidate.dailySales)} 件/日</dd></div>
        <div><dt>三仓可用</dt><dd>{amount.format(candidate.availableQty)} 件</dd></div>
        <div><dt>现货覆盖</dt><dd>{candidate.dailySales > 0 ? `约 ${amount.format(candidate.availableQty / candidate.dailySales)} 天` : '待核'}</dd></div>
        <div><dt>交期内在途</dt><dd>{calculation ? `${amount.format(calculation.eligibleInboundQty)} 件` : '待核'}</dd></div>
        <div><dt>目标库存</dt><dd>{calculation ? `${amount.format(calculation.targetQty)} 件` : '待核'}</dd></div>
        <div className="replenishment-pilot-result"><dt>建议采购</dt><dd>{calculation ? `${amount.format(calculation.recommendedQty)} 件` : '待核'}</dd></div>
      </dl>
      {calculation ? <>
        <div className="replenishment-pilot-fields">
          <label>
            <input className="replenishment-pilot-checkbox" type="checkbox" checked={countInbound} disabled={!inboundKey || preparing} onChange={(event) => {
              onChange({ inboundConfirmation: event.target.checked ? inboundKey : null });
            }} />
            我已核对在途到仓日期和数量，纳入本次试算
          </label>
        </div>
        <p className="replenishment-pilot-calculation">
          日均按各店已核销量除以可信天数后相加。目标库存按日均乘以交期与安全库存总天数后向上取整。
          截至 <time dateTime={calculation.cutoffDate}>{calculation.cutoffDate}</time>，交期内在途 {amount.format(calculation.eligibleInboundQty)} 件，计入 {amount.format(calculation.countedInboundQty)} 件。
          建议采购量为目标库存扣减三仓可用和计入在途后的缺口，最低为 0 件。
        </p>
      </> : <p className="replenishment-pilot-blocker">
        {leadDays === null || safetyDays === null
          ? hasInputs ? `交期需为 1–${FEISHU_PILOT_MAX_DAYS} 天，安全库存需为 0–${FEISHU_PILOT_MAX_DAYS} 天，均填整数。` : '填写实际交期和安全库存天数后可计算建议。'
          : '现有数据不足，补货建议待核。'}
      </p>}
      {hasPurchaseInProgress && context && <p className="replenishment-pilot-blocker">
        {context.pendingRequests > 0 && `${context.pendingRequests} 笔进行中的采购申请`}
        {context.pendingRequests > 0 && context.outstanding > 0 && ' · '}
        {context.outstanding > 0 && `已有采购单待到 ${amount.format(context.outstanding)} 件`}
        。请先核对已有申请和采购单，再确认还需补多少货。
      </p>}
      {onPrepareRequest && calculation && calculation.recommendedQty > 0 && <div className="replenishment-pilot-actions">
        <span className="replenishment-pilot-note">{overRequestLimit
          ? `手工申请每个 SKU 最多 ${amount.format(maxRequestQuantity)} 件，请核对建议量。`
          : context?.skuId ? '预填手工采购申请，确认后可保存草稿。' : '带入前会核对 ERP 中的 SKU。'}</span>
        <button className="primary-button" type="button" disabled={Boolean(preparingSku) || overRequestLimit} onClick={() => { void prepareDraft(); }}>
          {preparing ? '正在核对…' : context?.skuId ? '预填手工采购申请' : '核对 SKU 后带入'}
        </button>
      </div>}
      {prepareError && <p className="replenishment-pilot-blocker" role="alert">{prepareError}</p>}
    </> : <p className="replenishment-pilot-blocker">最新快照中的销量或库存待核，暂无法试算。</p>}
  </li>;
}
