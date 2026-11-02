'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type ModuleKey = 'dashboard' | 'platform' | 'orders' | 'inventory' | 'purchase' | 'warehouse' | 'logistics' | 'finance' | 'reports';
type OrderStatus = 'pending_review' | 'reserved' | 'shipped' | 'cancelled';
type OrderAction = 'approve' | 'ship' | 'cancel';
type Permission = 'orders:read' | 'orders:create' | 'orders:approve' | 'orders:ship' | 'orders:cancel' | 'audit:read' | 'connectors:read' | 'connectors:sync' | 'purchase:read' | 'purchase:mapping' | 'purchase:create' | 'purchase:submit' | 'purchase:review';

type ErpOrder = {
  id: string; orderNo: string; channel: string; destination: string; customerName: string;
  currency: string; amountMinor: number; status: OrderStatus; skuId: string; skuCode: string;
  skuName: string; warehouseId: string; warehouseName: string; quantity: number;
  version: number; createdAt: string; updatedAt: string;
};

type Inventory = {
  id: string; skuId: string; skuCode: string; skuName: string; warehouseId: string;
  warehouseName: string; onHandQty: number; reservedQty: number; availableQty: number;
  version: number; updatedAt: string;
};

type PlatformOrder = {
  id: string; platform: string; storeKey: string; storeName: string; sourceOrderId: string;
  sourceOrderName: string | null; sourceCreatedAt: string; sourceUpdatedAt: string;
  sourceCancelledAt: string | null; test: boolean | null; financialStatus: string | null;
  fulfillmentStatus: string | null; currency: string | null; currentTotalAmount: string | null;
  currentTotalMinor: number | null; refundedAmount: string | null; refundedMinor: number | null;
  businessOwnership: string | null; apiVersion: string; lineCount: number; refundCount: number;
  fulfillmentCount: number;
};

type PurchaseDemandStatus = 'needs_mapping' | 'open' | 'not_required';

type PurchaseDemand = {
  id: string; platform: string; storeKey: string; storeName: string; sourceOrderId: string;
  sourceOrderName: string | null; sourceOrderLineId: string; rawSku: string | null;
  normalizedSku: string | null; mappedSkuId: string | null; mappedSkuCode: string | null;
  mappedSkuName: string | null; title: string | null; name: string | null;
  orderedQuantity: number; currentQuantity: number | null; unfulfilledQuantity: number | null;
  requiredQuantity: number; allocatedQuantity?: number; availableQuantity?: number;
  status: PurchaseDemandStatus; reasonCode: string | null;
  sourceUpdatedAt: string; firstSeenAt: string; lastRefreshedAt: string; updatedAt: string;
};

type PurchaseMember = { id: string; displayName: string; role: 'admin' | 'operator' | 'viewer' };
type PurchaseSkuOption = { id: string; code: string; name: string };
type PurchaseRequestStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'cancelled';
type PurchaseRequestLine = {
  id: string; demandId: string; skuId: string; skuCode?: string | null; skuName?: string | null;
  rawSku?: string | null; requestedQuantity: number; sourceRequiredQuantity?: number;
};
type PurchaseRequest = {
  id: string; requestNo: string; status: PurchaseRequestStatus;
  buyer: PurchaseMember | null; reviewer: PurchaseMember | null; creator: PurchaseMember | null;
  purchaser?: PurchaseMember | null;
  purchaserMemberId?: string; purchaserName?: string; reviewerMemberId?: string; reviewerName?: string; creatorName?: string;
  lineCount: number; totalQuantity: number; note: string | null; reviewNote: string | null;
  needsAttention: boolean; createdAt: string; updatedAt: string; lines: PurchaseRequestLine[];
};

type PurchaseDemandSummary = {
  total: number; open: number; needsMapping: number; notRequired: number;
  openQuantity: number; needsMappingQuantity: number; availableQuantity?: number;
};

type PurchaseDemandsPayload = {
  ok: true;
  readOnly: true;
  demands: PurchaseDemand[];
  summary: PurchaseDemandSummary;
};

type PurchaseRequestSummary = {
  total: number; draft: number; pendingReview: number; approved: number; rejected: number; cancelled: number;
};

type PurchaseWorkspacePayload = {
  ok: true; readOnly?: boolean; demands: PurchaseDemand[]; summary: PurchaseDemandSummary & Partial<PurchaseRequestSummary>;
  requests: PurchaseRequest[];
  requestSummary?: PurchaseRequestSummary;
  members: PurchaseMember[]; skuOptions: PurchaseSkuOption[];
};

type ShopifyStatus = {
  ok: true; apiVersion: string; readOnly: true;
  stores: Array<{
    key: 'zimasya' | 'kaguyasu' | 'anzhap' | 'bizfurniz'; displayName: string;
    expectedDomain: string; appConfigured: boolean; encryptionReady: boolean; credentialsConfigured: boolean;
    authorizationRequired: boolean; authorizationStartUrl: string | null;
    authorizationVerified: boolean; authorizationUpdatedAt: string | null;
    accessTokenExpiresAt: string | null; refreshTokenExpiresAt: string | null;
    identityVerified: boolean;
    officialStoreId: string | null; verifiedDomain: string | null; identityVerifiedAt: string | null;
    lastSuccessfulSyncAt: string | null; completedWatermark: string | null;
    syncStatus: string; lastErrorCode: string | null;
  }>;
};

type OAuthFailureNotice = { message: string; retryUrl: string };

const shopifyOAuthFailureMessages: Record<string, string> = {
  AUTH_REQUIRED: 'ERP 登录状态已失效，请重新登录后再授权 Shopify。',
  ERP_ACCESS_NOT_ALLOWED: '当前站点版本仍启用了旧访问名单，请刷新后重试。',
  ERP_SYNC_OPERATOR_EMAIL_REQUIRED: '请使用 ERP 指定管理员账号重新发起 Shopify 授权。',
  SHOPIFY_OAUTH_SESSION_MISSING: '授权会话已失效。请从这里重新授权，并尽快完成 Shopify 页面确认。',
  SHOPIFY_OAUTH_CALLBACK_INVALID: 'Shopify 返回的授权校验未通过，请从这里重新授权。',
  SHOPIFY_TOKEN_EXCHANGE_REJECTED: 'Shopify 拒绝了凭证交换；系统已记录失败环节，需要核对应用客户端密钥。',
  SHOPIFY_TOKEN_EXCHANGE_NETWORK_ERROR: 'ERP 暂时未能连接 Shopify 授权服务，请重新授权。',
  SHOPIFY_IDENTITY_MISMATCH: '返回的 Shopify 店铺与 ERP 配置不一致，授权未保存。',
  SHOPIFY_REQUIRED_SCOPE_MISSING: '本次授权缺少订单只读权限，请重新授权并确认全部权限。',
  SHOPIFY_AUTH_INVALID_RESPONSE: 'Shopify 授权响应不完整，请重新授权。',
};

function shopifyOAuthFailureMessage(code: string | null) {
  return (code && shopifyOAuthFailureMessages[code])
    ?? 'Shopify 授权没有保存。系统已记录失败环节，请重新授权。';
}

type ErpPayload = {
  ok: true;
  user: { displayName: string; email: string; role: 'admin' | 'operator' | 'viewer'; permissions: Permission[]; tenantName: string };
  orders: ErpOrder[];
  platformOrders: PlatformOrder[];
  inventory: Inventory[];
  audit: { action: string; entity_id: string; actor_email: string; before_json: string | null; after_json: string | null; created_at: string }[];
  summary: { totalOrders: number; totalPlatformOrders: number; platformPending: number; platformCancelled: number; platformRefunded: number; pendingReview: number; readyToShip: number; shipped: number; lowStock: number; totalAvailable: number };
};

const nav: { key: ModuleKey; label: string; code: string }[] = [
  { key: 'dashboard', label: '工作台', code: '01' },
  { key: 'platform', label: '平台订单', code: '02' },
  { key: 'orders', label: '运营订单', code: '03' },
  { key: 'inventory', label: '商品库存', code: '04' },
  { key: 'purchase', label: '采购管理', code: '05' },
  { key: 'warehouse', label: '仓库作业', code: '06' },
  { key: 'logistics', label: '物流管理', code: '07' },
  { key: 'finance', label: '财务管理', code: '08' },
  { key: 'reports', label: '数据报表', code: '09' },
];

const statusLabel: Record<OrderStatus, string> = {
  pending_review: '待审核', reserved: '待发货', shipped: '已发货', cancelled: '已取消',
};

const actionLabel: Record<string, string> = {
  CREATE_ORDER: '创建订单', APPROVE_ORDER: '审核并预占', SHIP_ORDER: '确认发货', CANCEL_ORDER: '取消订单',
};

const purchaseDemandStatusLabel: Record<PurchaseDemandStatus, string> = {
  needs_mapping: '待 SKU 映射', open: '开放需求', not_required: '无需采购',
};

const purchaseDemandReasonLabel: Record<string, string> = {
  line_removed: '订单行已移除', test_order: '测试订单', cancelled_order: '订单已取消',
  fulfilled_order: '订单已履约', no_unfulfilled_quantity: '无未履约数量', sku_missing: '订单行缺少 SKU',
  sku_ambiguous: 'SKU 映射存在歧义', sku_unmapped: 'SKU 尚未映射',
};

const purchaseRequestStatusLabel: Record<PurchaseRequestStatus, string> = {
  draft: '草稿', pending_review: '待复审', approved: '已批准', rejected: '已驳回', cancelled: '已取消',
};

type PurchaseTab = 'pending' | 'mapping' | 'requests' | 'history';

const plannedModules: Record<Exclude<ModuleKey, 'dashboard' | 'platform' | 'orders' | 'inventory'>, {
  title: string; desc: string; source: string;
}> = {
  purchase: { title: '采购管理', desc: '采购计划、供应商下单与到货入库', source: '采购单或供应商数据' },
  warehouse: { title: '仓库作业', desc: '入库、拣货、复核、装箱与盘点', source: '仓库或 WMS 数据' },
  logistics: { title: '物流管理', desc: '面单、承运商、物流轨迹与异常处理', source: '承运商或物流服务商数据' },
  finance: { title: '财务管理', desc: '平台结算、多币种、费用与对账', source: '平台账单或财务数据' },
  reports: { title: '数据报表', desc: '基于可信业务明细生成统一口径报表', source: '已入库的真实业务明细' },
};

const emptyPurchaseSummary: PurchaseDemandSummary = {
  total: 0, open: 0, needsMapping: 0, notRequired: 0, openQuantity: 0, needsMappingQuantity: 0,
};

const emptyPurchaseRequestSummary: PurchaseRequestSummary = {
  total: 0, draft: 0, pendingReview: 0, approved: 0, rejected: 0, cancelled: 0,
};

export default function ErpClient() {
  const [active, setActive] = useState<ModuleKey>('dashboard');
  const [payload, setPayload] = useState<ErpPayload | null>(null);
  const [purchasePayload, setPurchasePayload] = useState<PurchaseWorkspacePayload | null>(null);
  const [shopifyStatus, setShopifyStatus] = useState<ShopifyStatus | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [oauthFailure, setOAuthFailure] = useState<OAuthFailureNotice | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [syncBusy, setSyncBusy] = useState('');
  const [purchaseTab, setPurchaseTab] = useState<PurchaseTab>('pending');
  const [selectedDemandIds, setSelectedDemandIds] = useState<Set<string>>(new Set());
  const [mappingDemand, setMappingDemand] = useState<PurchaseDemand | null>(null);
  const [showPurchaseRequest, setShowPurchaseRequest] = useState(false);
  const [purchaseBusy, setPurchaseBusy] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/erp', { cache: 'no-store' });
      const body = await response.json() as ErpPayload | { message?: string };
      if (response.status === 401) { setAuthRequired(true); return; }
      if (!response.ok || !('ok' in body) || body.ok !== true) throw new Error('message' in body ? body.message : '业务数据加载失败');
      setPayload(body);
      let purchaseResponse = await fetch('/api/purchase/workspace', { cache: 'no-store' });
      if (purchaseResponse.status === 404) purchaseResponse = await fetch('/api/purchase/demands', { cache: 'no-store' });
      const purchaseBody = await purchaseResponse.json() as PurchaseWorkspacePayload | PurchaseDemandsPayload | { message?: string };
      if (purchaseResponse.status === 401) { setAuthRequired(true); return; }
      if (!purchaseResponse.ok || !('ok' in purchaseBody) || purchaseBody.ok !== true) {
        throw new Error('message' in purchaseBody ? purchaseBody.message : '采购需求加载失败');
      }
      const normalizedPurchase = normalizePurchaseWorkspace(purchaseBody);
      setPurchasePayload(normalizedPurchase);
      setSelectedDemandIds((current) => new Set([...current].filter((id) => normalizedPurchase.demands.some(
        (demand) => demand.id === id && demand.status === 'open' && demandAvailableQuantity(demand) > 0,
      ))));
      const connectorResponse = await fetch('/api/connectors/shopify/status', { cache: 'no-store' });
      if (connectorResponse.ok) setShopifyStatus(await connectorResponse.json() as ShopifyStatus);
      setAuthRequired(false);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '业务数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const storeKey = params.get('shopify_oauth');
    const oauthStatus = params.get('status');
    if (storeKey && oauthStatus === 'connected') {
      window.history.replaceState({}, '', window.location.pathname);
      const startTimer = window.setTimeout(() => {
        setActive('platform');
        setToast('Shopify 只读授权已安全保存，可以开始首次同步');
      }, 0);
      const clearTimer = window.setTimeout(() => setToast(''), 3600);
      return () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(clearTimer);
      };
    }
    if (storeKey && oauthStatus === 'error') {
      window.history.replaceState({}, '', window.location.pathname);
      const safeStoreKey = ['zimasya', 'kaguyasu', 'anzhap', 'bizfurniz'].includes(storeKey)
        ? storeKey
        : 'bizfurniz';
      const startTimer = window.setTimeout(() => {
        setActive('platform');
        setOAuthFailure({
          message: shopifyOAuthFailureMessage(params.get('code')),
          retryUrl: `/api/connectors/shopify/oauth/${safeStoreKey}/start`,
        });
      }, 0);
      return () => window.clearTimeout(startTimer);
    }
    return undefined;
  }, []);

  const can = useCallback((permission: Permission) => payload?.user.permissions.includes(permission) ?? false, [payload]);
  const filteredOrders = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return payload?.orders ?? [];
    return (payload?.orders ?? []).filter((order) => [order.orderNo, order.channel, order.destination, order.customerName, order.skuCode, order.skuName, order.warehouseName, statusLabel[order.status]].some((value) => value.toLowerCase().includes(term)));
  }, [payload, query]);
  const filteredInventory = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return payload?.inventory ?? [];
    return (payload?.inventory ?? []).filter((item) => [item.skuCode, item.skuName, item.warehouseName].some((value) => value.toLowerCase().includes(term)));
  }, [payload, query]);
  const filteredPlatformOrders = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return payload?.platformOrders ?? [];
    return (payload?.platformOrders ?? []).filter((order) => [
      order.sourceOrderName ?? order.sourceOrderId,
      order.storeName,
      order.financialStatus ?? '',
      order.fulfillmentStatus ?? '',
    ].some((value) => value.toLowerCase().includes(term)));
  }, [payload, query]);
  const filteredPurchaseDemands = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return purchasePayload?.demands ?? [];
    return (purchasePayload?.demands ?? []).filter((demand) => [
      demand.sourceOrderName ?? demand.sourceOrderId,
      demand.sourceOrderId,
      demand.sourceOrderLineId,
      demand.storeName,
      demand.rawSku ?? '',
      demand.normalizedSku ?? '',
      demand.mappedSkuCode ?? '',
      demand.title ?? demand.name ?? '',
      purchaseDemandStatusLabel[demand.status],
      demand.reasonCode ? (purchaseDemandReasonLabel[demand.reasonCode] ?? demand.reasonCode) : '',
    ].some((value) => value.toLowerCase().includes(term)));
  }, [purchasePayload, query]);
  const filteredPurchaseRequests = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return purchasePayload?.requests ?? [];
    return (purchasePayload?.requests ?? []).filter((request) => [
      request.requestNo,
      request.buyer?.displayName ?? '',
      request.reviewer?.displayName ?? '',
      request.creator?.displayName ?? '',
      purchaseRequestStatusLabel[request.status],
      request.note ?? '',
      ...request.lines.flatMap((line) => [line.skuCode ?? '', line.skuName ?? '', line.rawSku ?? '']),
    ].some((value) => value.toLowerCase().includes(term)));
  }, [purchasePayload, query]);

  function switchModule(key: ModuleKey) { setActive(key); setQuery(''); }
  function flash(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2800); }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const inventory = payload?.inventory.find((item) => item.id === data.get('inventory'));
    if (!inventory) { setError('请选择有效的 SKU 和仓库'); return; }
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          channel: data.get('channel'), destination: data.get('destination'), customerName: data.get('customer'),
          currency: data.get('currency'), amountMinor: Math.round(Number(data.get('amount')) * 100),
          skuId: inventory.skuId, warehouseId: inventory.warehouseId, quantity: Number(data.get('quantity')),
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '订单创建失败');
      form.reset(); setShowOrder(false); setActive('orders'); await loadData();
      flash('订单已持久化保存，并进入待审核队列');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '订单创建失败');
    } finally { setSubmitting(false); }
  }

  async function runAction(order: ErpOrder, action: OrderAction) {
    const message = action === 'approve'
      ? `将为 ${order.orderNo} 在${order.warehouseName}预占 ${order.quantity} 件 ${order.skuCode}，确认审核？`
      : action === 'ship'
        ? `将扣减 ${order.quantity} 件现存库存并写入不可变出库流水，确认发货？`
        : `将取消 ${order.orderNo} 并释放已预占库存（如有）。订单和历史不会被删除，确认继续？`;
    if (!window.confirm(message)) return;
    setActionBusy(`${order.id}:${action}`); setError('');
    try {
      const response = await fetch(`/api/orders/${order.id}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ action }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '订单操作失败');
      await loadData();
      flash(action === 'approve' ? '审核完成，库存已预占' : action === 'ship' ? '发货完成，库存流水已更新' : '订单已取消，历史记录已保留');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '订单操作失败');
    } finally { setActionBusy(''); }
  }

  async function runShopifySync(store: ShopifyStatus['stores'][number]) {
    if (!store.credentialsConfigured || syncBusy) return;
    const firstRun = !store.completedWatermark;
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const message = firstRun
      ? `将只读回补 ${store.displayName} 最近 7 天订单，不会向 Shopify 写入任何状态，确认继续？`
      : `将从上次水位重叠回扫并增量同步 ${store.displayName}，确认继续？`;
    if (!window.confirm(message)) return;
    setSyncBusy(store.key); setError('');
    try {
      const response = await fetch('/api/connectors/shopify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firstRun
          ? { storeKey: store.key, mode: 'backfill', from: from.toISOString(), to: to.toISOString() }
          : { storeKey: store.key, mode: 'incremental' }),
      });
      const result = await response.json() as { message?: string; stats?: { ordersSeen?: number } };
      if (!response.ok) throw new Error(result.message ?? 'Shopify 同步失败');
      await loadData();
      flash(`只读同步完成，本次核对 ${result.stats?.ordersSeen ?? 0} 个订单`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Shopify 同步失败');
    } finally { setSyncBusy(''); }
  }

  function togglePurchaseDemand(id: string) {
    setSelectedDemandIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submitSkuMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mappingDemand) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const mode = String(data.get('mappingMode') ?? 'existing');
    const payloadBody = mode === 'new'
      ? { demandId: mappingDemand.id, newSku: { code: String(data.get('newSkuCode') ?? ''), name: String(data.get('newSkuName') ?? '') } }
      : { demandId: mappingDemand.id, skuId: String(data.get('skuId') ?? '') };
    setPurchaseBusy(`mapping:${mappingDemand.id}`); setError('');
    try {
      const response = await fetch('/api/purchase/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(payloadBody),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? 'SKU 映射失败');
      setMappingDemand(null);
      await loadData();
      setPurchaseTab('pending');
      flash('SKU 已映射，相关真实订单需求已进入待采购');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SKU 映射失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitPurchaseRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === 'submit' ? 'submit' : 'draft';
    setPurchaseBusy('create-request'); setError('');
    try {
      const response = await fetch('/api/purchase/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          demandIds: [...selectedDemandIds],
          purchaserMemberId: String(data.get('purchaserMemberId') ?? ''),
          reviewerMemberId: String(data.get('reviewerMemberId') ?? ''),
          note: String(data.get('note') ?? '').trim() || undefined,
        }),
      });
      const body = await response.json() as { message?: string; request?: { id?: string } };
      if (!response.ok) throw new Error(body.message ?? '采购申请创建失败');
      if (intent === 'submit') {
        if (!body.request?.id) throw new Error('采购申请已创建，但返回结果缺少申请标识，请刷新后提交');
        const submitResponse = await fetch(`/api/purchase/requests/${body.request.id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ action: 'submit' }),
        });
        const submitBody = await submitResponse.json() as { message?: string };
        if (!submitResponse.ok) throw new Error(submitBody.message ?? '采购申请已保存为草稿，但提交复审失败');
      }
      setShowPurchaseRequest(false); setSelectedDemandIds(new Set());
      await loadData();
      setPurchaseTab('requests');
      flash(intent === 'submit' ? '采购申请已创建并提交复审' : '采购申请草稿已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购申请创建失败');
    } finally { setPurchaseBusy(''); }
  }

  async function runPurchaseRequestAction(request: PurchaseRequest, action: 'submit' | 'approve' | 'reject' | 'cancel') {
    let note = '';
    if (action === 'reject') {
      const reason = window.prompt(`请输入驳回 ${request.requestNo} 的原因，需求将被释放但历史不会删除：`);
      if (reason === null) return;
      note = reason.trim();
      if (!note) { setError('驳回时必须填写原因'); return; }
    } else {
      const message = action === 'approve'
        ? `确认批准 ${request.requestNo}？批准后需求将保持占用，避免重复采购。`
        : action === 'cancel'
          ? `确认取消 ${request.requestNo}？需求会重新释放，申请历史不会删除。`
          : `确认提交 ${request.requestNo} 进入复审？`;
      if (!window.confirm(message)) return;
    }
    setPurchaseBusy(`${request.id}:${action}`); setError('');
    try {
      const response = await fetch(`/api/purchase/requests/${request.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ action, note: note || undefined }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '采购申请操作失败');
      await loadData();
      flash(action === 'submit' ? '已提交复审' : action === 'approve' ? '复审已批准' : action === 'reject' ? '已驳回并释放需求' : '草稿已取消并释放需求');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购申请操作失败');
    } finally { setPurchaseBusy(''); }
  }

  const activeLabel = nav.find((item) => item.key === active)?.label ?? '工作台';
  const displayName = payload?.user.displayName || '未登录';
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => switchModule('dashboard')}><span className="brand-mark">易</span><span>易仓 ERP</span></button>
        <div className="pilot-tag"><span />真实数据模式 · 不生成样例</div>
        <p className="nav-label">业务中心</p>
        <nav>{nav.map((item) => <button className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => switchModule(item.key)} key={item.key}><span className="nav-icon">{item.code}</span>{item.label}{item.key === 'orders' && Boolean(payload?.summary.pendingReview) && <b>{payload?.summary.pendingReview}</b>}</button>)}</nav>
        <div className="sidebar-foot"><div className="help-icon">✓</div><div><strong>可信业务底座</strong><small>身份 · 幂等 · 审计 · 库存流水</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="crumb"><span>{payload?.user.tenantName ?? '易仓 ERP 工作区'}</span><i>／</i><strong>{activeLabel}</strong></div>
          <div className="top-actions">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索当前模块" placeholder={active === 'dashboard' ? '切换模块后搜索业务数据' : `搜索${activeLabel}`} /></label>
            <div className="live-badge"><i />仅真实数据</div>
            <div className="avatar">{initials}</div><div className="user"><strong>{displayName}</strong><small>{payload?.user.role === 'admin' ? '系统管理员' : payload?.user.role === 'operator' ? '业务操作员' : '只读成员'}</small></div>
          </div>
        </header>

        {authRequired ? <AuthRequired /> : loading && !payload ? <LoadingState /> : payload ? (
          <>
            {oauthFailure && <div className="inline-alert" role="alert"><span>!</span><p>{oauthFailure.message}</p><button onClick={() => window.location.assign(oauthFailure.retryUrl)}>重新授权</button></div>}
            {error && <div className="inline-alert" role="alert"><span>!</span><p>{error}</p><button onClick={() => { setError(''); void loadData(); }}>重试</button></div>}
            {active === 'dashboard' && <Dashboard payload={payload} openOrder={() => setShowOrder(true)} go={switchModule} />}
            {active === 'platform' && <PlatformOrdersView orders={filteredPlatformOrders} summary={payload.summary} status={shopifyStatus} canSync={can('connectors:sync')} syncBusy={syncBusy} runSync={runShopifySync} />}
            {active === 'orders' && <OrdersView orders={filteredOrders} summary={payload.summary} inventoryReady={payload.inventory.length > 0} hasQuery={Boolean(query.trim())} can={can} busy={actionBusy} openOrder={() => setShowOrder(true)} runAction={runAction} />}
            {active === 'inventory' && <InventoryView inventory={filteredInventory} summary={payload.summary} hasInventoryData={payload.inventory.length > 0} hasQuery={Boolean(query.trim())} />}
            {active === 'purchase' && <PurchaseWorkspaceView demands={filteredPurchaseDemands} requests={filteredPurchaseRequests} workspace={purchasePayload} tab={purchaseTab} setTab={setPurchaseTab} selectedDemandIds={selectedDemandIds} toggleDemand={togglePurchaseDemand} openMapping={setMappingDemand} openRequest={() => setShowPurchaseRequest(true)} can={can} busy={purchaseBusy} runAction={runPurchaseRequestAction} hasQuery={Boolean(query.trim())} />}
            {!['dashboard','platform','orders','inventory','purchase'].includes(active) && <PlannedModule module={plannedModules[active as keyof typeof plannedModules]} />}
          </>
        ) : <LoadingState message={error || '暂时无法加载业务数据'} />}
      </section>

      {showOrder && payload && <OrderModal inventory={payload.inventory} submitting={submitting} error={error} onClose={() => { if (!submitting) { setShowOrder(false); setError(''); } }} onSubmit={submitOrder} />}
      {mappingDemand && purchasePayload && <SkuMappingModal demand={mappingDemand} skuOptions={purchasePayload.skuOptions} busy={purchaseBusy.startsWith('mapping:')} error={error} onClose={() => { if (!purchaseBusy) { setMappingDemand(null); setError(''); } }} onSubmit={submitSkuMapping} />}
      {showPurchaseRequest && purchasePayload && <PurchaseRequestModal demands={purchasePayload.demands.filter((demand) => selectedDemandIds.has(demand.id))} members={purchasePayload.members} busy={purchaseBusy === 'create-request'} error={error} onClose={() => { if (!purchaseBusy) { setShowPurchaseRequest(false); setError(''); } }} onSubmit={submitPurchaseRequest} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

function Dashboard({ payload, openOrder, go }: { payload: ErpPayload; openOrder: () => void; go: (key: ModuleKey) => void }) {
  const inventoryReady = payload.inventory.length > 0;
  const hasBusinessData = payload.platformOrders.length > 0 || payload.orders.length > 0 || inventoryReady;
  const metrics = [
    ['平台订单', String(payload.summary.totalPlatformOrders), '官方 API 原始事实', 'green'],
    ['待审核', String(payload.summary.pendingReview), '需审核后预占库存', 'orange'],
    ['待发货', String(payload.summary.readyToShip), '库存已锁定', 'blue'],
    ['低库存 SKU', String(payload.summary.lowStock), '可售量 ≤ 10', 'red'],
  ];
  return <div className="content"><div className="page-head"><div><p>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date())}</p><h1>早上好，{payload.user.displayName}</h1><span>系统只展示已接入数据库的业务记录，不生成或补齐样例数据。</span></div>{payload.user.permissions.includes('orders:create') && <button className="primary-button" onClick={openOrder} disabled={!inventoryReady} title={inventoryReady ? '新建订单' : '请先接入真实 SKU、仓库和库存'}><span>＋</span> 新建订单</button>}</div>
    {!hasBusinessData && <DataSourceNotice />}
    <section className="metrics" aria-label="核心业务指标">{metrics.map((metric) => <article className="metric-card" key={metric[0]}><div className={`metric-symbol ${metric[3]}`}>{metric[0].slice(0,1)}</div><p>{metric[0]}</p><h2>{metric[1]}</h2><span className={metric[3] === 'red' ? 'negative' : ''}>{metric[2]}</span></article>)}</section>
    <div className="dashboard-grid"><article className="card workflow-card"><div className="card-head"><div><h3>平台订单接入链路</h3><p>官方 API 只读同步，原始事实与运营动作分层</p></div><button className="link-button" onClick={() => go('platform')}>进入平台订单 →</button></div><div className="workflow-line"><div className="flow-step active"><b>01</b><span><strong>官方 API</strong><small>只读获取</small></span></div><i>→</i><div className="flow-step"><b>02</b><span><strong>分页增量</strong><small>重叠回扫</small></span></div><i>→</i><div className="flow-step"><b>03</b><span><strong>事实入库</strong><small>幂等更新</small></span></div><i>→</i><div className="flow-step"><b>04</b><span><strong>业务投影</strong><small>另行审核</small></span></div></div><div className="guardrails"><span>店铺身份核验</span><span>只读权限</span><span>断点续跑</span><span>原币保存</span><span>无物理删除</span></div></article>
      <article className="card audit-card"><div className="card-head"><div><h3>最近审计</h3><p>创建、审核、发货与取消均自动留痕</p></div><span className="audit-lock">追加写</span></div><div className="audit-list">{payload.audit.slice(0, 4).map((item, index) => <div className="audit-item" key={`${item.entity_id}-${item.created_at}-${index}`}><span className="audit-dot" /><div><strong>{actionLabel[item.action] ?? item.action}</strong><small>{item.actor_email} · {formatTime(item.created_at)}</small></div></div>)}{!payload.audit.length && <p className="empty-note">{payload.user.permissions.includes('audit:read') ? '暂无业务操作记录' : '当前账号无审计查看权限'}</p>}</div></article></div>
    <article className="card orders-card"><div className="card-head"><div><h3>最新系统订单</h3><p>仅显示数据库中已接入的真实订单</p></div><button className="link-button" onClick={() => go('orders')}>查看全部 →</button></div><OrderTable orders={payload.orders.slice(0, 4)} compact /></article>
  </div>;
}

function PlatformOrdersView({ orders, summary, status, canSync, syncBusy, runSync }: {
  orders: PlatformOrder[];
  summary: ErpPayload['summary'];
  status: ShopifyStatus | null;
  canSync: boolean;
  syncBusy: string;
  runSync: (store: ShopifyStatus['stores'][number]) => void;
}) {
  const stats = [
    ['已入库订单', String(summary.totalPlatformOrders), '平台原始订单事实'],
    ['Pending', String(summary.platformPending), '原状态保留'],
    ['已取消', String(summary.platformCancelled), '不提前剔除'],
    ['含退款', String(summary.platformRefunded), '退款对象独立保存'],
  ];
  return <div className="content module-content"><div className="module-head"><div><p>多店铺接入 / Shopify 第一阶段</p><h1>平台订单</h1><span>订单、订单行、退款交易、履约与追踪均从官方 API 只读同步；不会自动改平台或扣 ERP 库存。</span></div><div className="ledger-chip">Admin GraphQL {status?.apiVersion ?? '2026-07'} · 只读</div></div><StatCards stats={stats} />
    <section className="connector-grid">{status?.stores.map((store) => <article className="card connector-card" key={store.key}><div className="connector-card-head"><div><p>SHOPIFY</p><h3>{store.displayName}</h3><small>{store.verifiedDomain ?? store.expectedDomain}</small></div><span className={store.identityVerified ? 'connector-state ready' : store.credentialsConfigured ? 'connector-state pending' : 'connector-state'}>{store.identityVerified ? '身份已核验' : store.authorizationVerified ? '已授权待同步' : store.appConfigured && store.encryptionReady ? '待授权' : store.appConfigured ? '密钥待配置' : '应用待配置'}</span></div><dl><div><dt>同步水位</dt><dd>{store.completedWatermark ? formatTime(store.completedWatermark) : '尚未建立'}</dd></div><div><dt>运行状态</dt><dd>{store.syncStatus === 'idle' ? '正常' : store.syncStatus === 'failed' ? `失败：${store.lastErrorCode ?? '待重试'}` : store.syncStatus === 'running' ? '同步中' : '未开始'}</dd></div></dl>{canSync && store.credentialsConfigured && <button className="primary-button connector-sync" disabled={Boolean(syncBusy)} onClick={() => runSync(store)}>{syncBusy === store.key ? '只读同步中…' : store.completedWatermark ? '运行增量同步' : '回补最近 7 天'}</button>}{canSync && !store.credentialsConfigured && store.authorizationStartUrl && <a className="primary-button connector-sync" href={store.authorizationStartUrl}>授权只读订单</a>}{canSync && !store.credentialsConfigured && !store.authorizationStartUrl && <button className="primary-button connector-sync" disabled>{store.appConfigured && !store.encryptionReady ? '加密密钥待配置' : store.appConfigured ? '等待授权配置' : '应用参数待配置'}</button>}</article>)}{!status && <article className="card connector-card"><p>正在读取连接器状态…</p></article>}</section>
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部平台订单</button></div><span>当前显示最近 {orders.length} 条</span></div><div className="table-wrap module-table"><table><thead><tr><th>平台订单</th><th>店铺</th><th>原始状态</th><th>订单行</th><th>退款 / 履约</th><th>原币当前金额</th><th>更新时间</th></tr></thead><tbody>{orders.length ? orders.map((order) => <tr key={order.id}><td><strong>{order.sourceOrderName ?? order.sourceOrderId}</strong><small className="cell-sub">{order.test ? '测试单 · ' : ''}{order.sourceCancelledAt ? '已取消' : '原始保留'}</small></td><td>{order.storeName}<small className="cell-sub">{order.platform}</small></td><td>{order.financialStatus ?? '未知'}<small className="cell-sub">{order.fulfillmentStatus ?? '履约未知'}</small></td><td>{order.lineCount}</td><td>{order.refundCount} / {order.fulfillmentCount}</td><td>{formatExactMoney(order.currentTotalAmount, order.currency)}</td><td>{formatTime(order.sourceUpdatedAt)}</td></tr>) : <tr><td className="empty-cell" colSpan={7}>尚未取得 ERP 独立店铺授权；连接器、数据模型和幂等入库已准备好，不会用模拟订单填充。</td></tr>}</tbody></table></div></article>
  </div>;
}

function OrdersView({ orders, summary, inventoryReady, hasQuery, can, busy, openOrder, runAction }: { orders: ErpOrder[]; summary: ErpPayload['summary']; inventoryReady: boolean; hasQuery: boolean; can: (permission: Permission) => boolean; busy: string; openOrder: () => void; runAction: (order: ErpOrder, action: OrderAction) => void }) {
  const stats = [['全部订单', String(summary.totalOrders), '持久化记录'],['待审核', String(summary.pendingReview), '审核后锁定库存'],['待发货', String(summary.readyToShip), '已完成库存预占'],['已发货', String(summary.shipped), '已写出库流水']];
  return <div className="content module-content"><div className="module-head"><div><p>可信业务闭环 / 订单</p><h1>订单管理</h1><span>创建、审核、预占、发货、取消均由服务端状态机控制</span></div>{can('orders:create') && <button className="primary-button" onClick={openOrder} disabled={!inventoryReady} title={inventoryReady ? '新建订单' : '请先接入真实 SKU、仓库和库存'}><span>＋</span> 新建订单</button>}</div>{!inventoryReady && <DataSourceNotice compact />}<StatCards stats={stats} />
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部</button><button>待审核</button><button>待发货</button><button>已完成</button></div><span>共 {orders.length} 条当前权限范围记录</span></div><OrderTable orders={orders} emptyMessage={hasQuery ? '没有符合当前搜索条件的订单' : '数据库中暂无订单；系统不会自动填充样例记录'} can={can} busy={busy} runAction={runAction} /><div className="pagination"><span>数据刷新后仍会保留</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></article>
  </div>;
}

function OrderTable({ orders, compact = false, emptyMessage = '数据库中暂无订单', can, busy = '', runAction }: { orders: ErpOrder[]; compact?: boolean; emptyMessage?: string; can?: (permission: Permission) => boolean; busy?: string; runAction?: (order: ErpOrder, action: OrderAction) => void }) {
  return <div className="table-wrap module-table"><table><thead><tr><th>订单号</th><th>渠道 / 目的地</th><th>商品</th><th>仓库</th><th>数量</th><th>原币金额</th><th>状态</th>{!compact && <th>受控操作</th>}</tr></thead><tbody>{orders.length ? orders.map((order) => <tr key={order.id}><td><strong>{order.orderNo}</strong><small className="cell-sub">{order.customerName}</small></td><td>{order.channel}<small className="cell-sub">{order.destination}</small></td><td>{order.skuCode}<small className="cell-sub">{order.skuName}</small></td><td>{order.warehouseName}</td><td>{order.quantity}</td><td>{formatMoney(order.amountMinor, order.currency)}</td><td><Status status={order.status} /></td>{!compact && <td><div className="row-actions">{order.status === 'pending_review' && can?.('orders:approve') && <button disabled={Boolean(busy)} onClick={() => runAction?.(order, 'approve')}>{busy === `${order.id}:approve` ? '处理中…' : '审核预占'}</button>}{order.status === 'reserved' && can?.('orders:ship') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction?.(order, 'ship')}>{busy === `${order.id}:ship` ? '处理中…' : '确认发货'}</button>}{['pending_review','reserved'].includes(order.status) && can?.('orders:cancel') && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction?.(order, 'cancel')}>取消</button>}{['shipped','cancelled'].includes(order.status) && <span className="terminal-label">终态已锁定</span>}</div></td>}</tr>) : <tr><td className="empty-cell" colSpan={compact ? 7 : 8}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function InventoryView({ inventory, summary, hasInventoryData, hasQuery }: { inventory: Inventory[]; summary: ErpPayload['summary']; hasInventoryData: boolean; hasQuery: boolean }) {
  const totalOnHand = inventory.reduce((sum, item) => sum + item.onHandQty, 0);
  const totalReserved = inventory.reduce((sum, item) => sum + item.reservedQty, 0);
  const stats = [['库存记录', String(inventory.length), 'SKU × 仓库'],['现存数量', String(totalOnHand), '不可由页面直接修改'],['预占数量', String(totalReserved), '由订单状态机维护'],['可售数量', String(summary.totalAvailable), '现存－预占']];
  return <div className="content module-content"><div className="module-head"><div><p>可信业务闭环 / 库存</p><h1>商品库存</h1><span>余额由不可变流水和订单动作驱动，页面不提供直接改数入口</span></div><div className="ledger-chip">库存账本已启用</div></div><StatCards stats={stats} />
    {!hasInventoryData && <DataSourceNotice compact />}
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部库存</button><button>库存预警</button></div><span>可售量 = 现存 − 预占</span></div><div className="table-wrap module-table"><table><thead><tr><th>SKU</th><th>商品名称</th><th>仓库</th><th>现存</th><th>预占</th><th>可售</th><th>库存状态</th><th>版本</th></tr></thead><tbody>{inventory.length ? inventory.map((item) => <tr key={item.id}><td><strong>{item.skuCode}</strong></td><td>{item.skuName}</td><td>{item.warehouseName}</td><td>{item.onHandQty}</td><td>{item.reservedQty}</td><td><strong>{item.availableQty}</strong></td><td><InventoryStatus available={item.availableQty} /></td><td>v{item.version}</td></tr>) : <tr><td className="empty-cell" colSpan={8}>{hasQuery ? '没有符合当前搜索条件的库存记录' : '尚未接入真实 SKU、仓库和库存记录'}</td></tr>}</tbody></table></div><div className="pagination"><span>订单审核、取消和发货后自动更新</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></article>
  </div>;
}

function PurchaseWorkspaceView({ demands, requests, workspace, tab, setTab, selectedDemandIds, toggleDemand, openMapping, openRequest, can, busy, runAction, hasQuery }: {
  demands: PurchaseDemand[]; requests: PurchaseRequest[]; workspace: PurchaseWorkspacePayload | null;
  tab: PurchaseTab; setTab: (tab: PurchaseTab) => void; selectedDemandIds: Set<string>;
  toggleDemand: (id: string) => void; openMapping: (demand: PurchaseDemand) => void; openRequest: () => void;
  can: (permission: Permission) => boolean; busy: string;
  runAction: (request: PurchaseRequest, action: 'submit' | 'approve' | 'reject' | 'cancel') => void;
  hasQuery: boolean;
}) {
  const summary = workspace?.summary ?? emptyPurchaseSummary;
  const requestSummary = workspace?.requestSummary ?? emptyPurchaseRequestSummary;
  const availableQuantity = summary.availableQuantity ?? demands.filter((demand) => demand.status === 'open').reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const stats = [
    ['待采购数量', String(availableQuantity), '可选需求的剩余件数'],
    ['待 SKU 映射', String(summary.needsMapping), `涉及 ${summary.needsMappingQuantity} 件`],
    ['待复审申请', String(requestSummary.pendingReview), '已提交，等待复审'],
    ['已批准申请', String(requestSummary.approved), '已锁定，避免重复采购'],
  ];
  const visibleDemands = tab === 'pending'
    ? demands.filter((demand) => demand.status === 'open' && demandAvailableQuantity(demand) > 0)
    : tab === 'mapping' ? demands.filter((demand) => demand.status === 'needs_mapping') : [];
  const visibleRequests = tab === 'requests'
    ? requests.filter((request) => request.status === 'draft' || request.status === 'pending_review')
    : requests.filter((request) => ['approved', 'rejected', 'cancelled'].includes(request.status));
  const selectedDemands = (workspace?.demands ?? []).filter((demand) => selectedDemandIds.has(demand.id));
  const selectedQuantity = selectedDemands.reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const tabs: Array<[PurchaseTab, string, number]> = [
    ['pending', '待处理需求', summary.open],
    ['mapping', '待 SKU 映射', summary.needsMapping],
    ['requests', '采购申请', requestSummary.draft + requestSummary.pendingReview],
    ['history', '历史记录', requestSummary.approved + requestSummary.rejected + requestSummary.cancelled],
  ];
  return <div className="content module-content"><div className="module-head"><div><p>真实订单 / 采购执行</p><h1>采购工作台</h1><span>真实订单自动形成采购需求；完成 SKU 映射后，可生成采购申请并进入复审。系统不会向 Shopify 写入。</span></div><div className="ledger-chip">需求防重复 · 历史不删除</div></div><StatCards stats={stats} />
    <article className="card data-card purchase-workspace-card"><div className="data-toolbar purchase-toolbar"><div>{tabs.map(([key, label, count]) => <button key={key} className={tab === key ? 'tab-active' : ''} onClick={() => setTab(key)}>{label}<b>{count}</b></button>)}</div><span>{tab === 'pending' ? `可采购 ${availableQuantity} 件` : tab === 'mapping' ? '映射后自动进入待处理' : `共 ${requests.length} 张申请`}</span></div>
      {tab === 'pending' || tab === 'mapping' ? <>
        {tab === 'pending' && <div className="purchase-selection"><div><strong>已选 {selectedDemandIds.size} 行 / {selectedQuantity} 件</strong><span>每条需求只能进入一张有效采购申请</span></div><button className="primary-button" disabled={!selectedDemandIds.size || !can('purchase:create') || Boolean(busy)} onClick={openRequest}><span>＋</span>生成采购申请</button></div>}
        <PurchaseDemandTable demands={visibleDemands} selectable={tab === 'pending'} selectedDemandIds={selectedDemandIds} toggleDemand={toggleDemand} openMapping={openMapping} canMap={can('purchase:mapping')} busy={busy} emptyMessage={hasQuery ? '没有符合当前搜索条件的需求' : tab === 'pending' ? '暂无可采购需求；待映射 SKU 完成后会出现在这里' : '暂无待映射的真实订单行'} />
      </> : <PurchaseRequestTable requests={visibleRequests} can={can} busy={busy} runAction={runAction} emptyMessage={hasQuery ? '没有符合当前搜索条件的采购申请' : tab === 'requests' ? '暂无草稿或待复审申请，可从待处理需求生成' : '暂无已结束的采购申请'} />}
      <div className="pagination"><span>订单取消、退款或履约变化会重新校验需求；所有申请和复审记录永久保留</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div>
    </article>
  </div>;
}

function PurchaseDemandTable({ demands, selectable, selectedDemandIds, toggleDemand, openMapping, canMap, busy, emptyMessage }: {
  demands: PurchaseDemand[]; selectable: boolean; selectedDemandIds: Set<string>; toggleDemand: (id: string) => void;
  openMapping: (demand: PurchaseDemand) => void; canMap: boolean; busy: string; emptyMessage: string;
}) {
  return <div className="table-wrap module-table"><table className="purchase-demand-table"><thead><tr>{selectable && <th className="selection-cell">选择</th>}<th>店铺 / 订单</th><th>平台 SKU / ERP SKU</th><th>商品</th><th>需求 / 已占 / 可采购</th><th>状态</th><th>操作</th><th>订单更新时间</th></tr></thead><tbody>{demands.length ? demands.map((demand) => {
    const available = demandAvailableQuantity(demand);
    return <tr key={demand.id}>{selectable && <td className="selection-cell"><input className="purchase-check" type="checkbox" aria-label={`选择 ${demand.rawSku ?? demand.sourceOrderLineId}`} checked={selectedDemandIds.has(demand.id)} disabled={available <= 0 || Boolean(busy)} onChange={() => toggleDemand(demand.id)} /></td>}<td><strong>{demand.storeName}</strong><small className="cell-sub">{demand.sourceOrderName ?? demand.sourceOrderId}</small></td><td><strong>{demand.rawSku?.trim() || '缺少 SKU'}</strong><small className="cell-sub">{demand.mappedSkuCode ? `ERP：${demand.mappedSkuCode}` : '尚未映射 ERP SKU'}</small></td><td>{demand.title ?? demand.name ?? '未提供商品名'}{demand.mappedSkuName && <small className="cell-sub">{demand.mappedSkuName}</small>}</td><td><strong>{demand.requiredQuantity} / {demand.allocatedQuantity ?? 0} / {available}</strong><small className="cell-sub">当前 / 未履约：{formatOptionalQuantity(demand.currentQuantity)} / {formatOptionalQuantity(demand.unfulfilledQuantity)}</small></td><td><span className={`status-pill ${demand.status === 'open' ? 'success' : ''}`}>{purchaseDemandStatusLabel[demand.status]}</span><small className="cell-sub">{demand.reasonCode ? (purchaseDemandReasonLabel[demand.reasonCode] ?? demand.reasonCode) : '已满足采购条件'}</small></td><td><div className="row-actions">{demand.status === 'needs_mapping' && canMap && demand.rawSku?.trim() && <button disabled={Boolean(busy)} onClick={() => openMapping(demand)}>映射 SKU</button>}{demand.status === 'needs_mapping' && !demand.rawSku?.trim() && <span className="terminal-label">平台未提供 SKU</span>}{demand.status === 'open' && <span className="terminal-label">{available > 0 ? '可生成申请' : '已进入申请'}</span>}</div></td><td>{formatTime(demand.sourceUpdatedAt)}</td></tr>;
  }) : <tr><td className="empty-cell" colSpan={selectable ? 8 : 7}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function PurchaseRequestTable({ requests, can, busy, runAction, emptyMessage }: {
  requests: PurchaseRequest[]; can: (permission: Permission) => boolean; busy: string;
  runAction: (request: PurchaseRequest, action: 'submit' | 'approve' | 'reject' | 'cancel') => void; emptyMessage: string;
}) {
  return <div className="table-wrap module-table"><table className="purchase-request-table"><thead><tr><th>申请单</th><th>采购负责人</th><th>复审人</th><th>明细 / 件数</th><th>状态</th><th>备注</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{requests.length ? requests.map((request) => <tr key={request.id}><td><strong>{request.requestNo}</strong><small className="cell-sub">创建：{request.creator?.displayName ?? '系统成员'}</small></td><td>{request.buyer?.displayName ?? '待指定'}</td><td>{request.reviewer?.displayName ?? '待指定'}</td><td>{request.lineCount} 行 / {request.totalQuantity} 件</td><td><span className={`status-pill purchase-status-${request.status}`}>{purchaseRequestStatusLabel[request.status]}</span>{request.needsAttention && <small className="cell-sub attention-text">源订单已变化，需复核</small>}</td><td>{request.reviewNote ?? request.note ?? '—'}</td><td>{formatTime(request.updatedAt)}</td><td><div className="row-actions">{request.status === 'draft' && can('purchase:submit') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction(request, 'submit')}>{busy === `${request.id}:submit` ? '提交中…' : '提交复审'}</button>}{request.status === 'draft' && can('purchase:submit') && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(request, 'cancel')}>取消</button>}{request.status === 'pending_review' && can('purchase:review') && <><button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction(request, 'approve')}>{busy === `${request.id}:approve` ? '复审中…' : '批准'}</button><button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(request, 'reject')}>驳回</button></>}{['approved','rejected','cancelled'].includes(request.status) && <span className="terminal-label">历史已保留</span>}</div></td></tr>) : <tr><td className="empty-cell" colSpan={8}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function PlannedModule({ module }: { module: (typeof plannedModules)[keyof typeof plannedModules] }) {
  return <div className="content module-content"><div className="module-head"><div><p>业务规划 / 数据源待接入</p><h1>{module.title}</h1><span>{module.desc}</span></div><div className="source-chip">当前无业务数据</div></div>
    <article className="card source-empty"><div className="source-empty-mark">0</div><p>真实数据源尚未接入</p><h2>这里不会展示虚构记录</h2><span>接入{module.source}后，本模块才会生成指标和明细。</span></article>
  </div>;
}

function DataSourceNotice({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'data-source-notice compact' : 'data-source-notice'}><div className="source-status">空</div><div><strong>当前数据库没有业务数据</strong><span>系统已关闭样例数据生成。接入 Excel / CSV 或平台 API 后，这里只显示你的真实记录。</span></div></div>;
}

function StatCards({ stats }: { stats: string[][] }) {
  return <section className="module-stats">{stats.map((stat, index) => <article key={stat[0]}><div className={`stat-dot tone-${index}`} /><p>{stat[0]}</p><h2>{stat[1]}</h2><span>{stat[2]}</span></article>)}</section>;
}

function OrderModal({ inventory, submitting, error, onClose, onSubmit }: { inventory: Inventory[]; submitting: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal order-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>新建销售订单</h2><p>订单先进入待审核；审核后才会预占库存</p></div><button type="button" onClick={onClose} disabled={submitting}>×</button></div><div className="form-grid"><label>销售渠道<select name="channel" required><option>Amazon US</option><option>Shopify</option><option>eBay DE</option><option>TikTok Shop</option></select></label><label>目的国家<select name="destination" required><option>美国</option><option>英国</option><option>德国</option><option>法国</option><option>加拿大</option></select></label><label className="full">客户名称<input name="customer" placeholder="请输入客户名称" required minLength={2} /></label><label className="full">SKU 与履约仓<select name="inventory" required>{inventory.map((item) => <option key={item.id} value={item.id}>{item.skuCode} · {item.skuName} · {item.warehouseName}（可售 {item.availableQty}）</option>)}</select></label><label>订购数量<input name="quantity" type="number" min="1" max="999" defaultValue="1" required /></label><label>币种<select name="currency" required><option value="USD">USD 美元</option><option value="EUR">EUR 欧元</option><option value="GBP">GBP 英镑</option><option value="CNY">CNY 人民币</option></select></label><label className="full">订单原币金额<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>安全规则</span>服务端生成订单号 · 重复提交不会重复建单 · 所有动作自动审计</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? '正在安全写入…' : '创建待审核订单'}</button></div></form></div>;
}

function SkuMappingModal({ demand, skuOptions, busy, error, onClose, onSubmit }: {
  demand: PurchaseDemand; skuOptions: PurchaseSkuOption[]; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(skuOptions.length ? 'existing' : 'new');
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>映射 ERP SKU</h2><p>同店铺、同平台 SKU 的需求会一起更新</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="mapping-context"><strong>{demand.storeName} · {demand.sourceOrderName ?? demand.sourceOrderId}</strong><span>{demand.title ?? demand.name ?? '未提供商品名'}</span><code>{demand.rawSku?.trim() || '平台未提供 SKU'}</code></div><div className="form-grid"><label className="full mapping-choice"><span><input type="radio" name="mappingMode" value="existing" checked={mode === 'existing'} disabled={!skuOptions.length} onChange={() => setMode('existing')} /> 选择已有 ERP SKU</span>{mode === 'existing' && <select name="skuId" required>{skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.name}</option>)}</select>}</label><label className="full mapping-choice"><span><input type="radio" name="mappingMode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} /> 新建并映射</span></label>{mode === 'new' && <><label>ERP SKU 编码<input name="newSkuCode" required placeholder={demand.normalizedSku ?? demand.rawSku ?? '例如 BF-001'} /></label><label>ERP SKU 名称<input name="newSkuName" required placeholder={demand.title ?? demand.name ?? '请输入商品名称'} /></label></>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>映射规则</span>保留平台原始 SKU · 映射可追溯 · 不会修改 Shopify 商品</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy || !demand.rawSku?.trim()}>{busy ? '正在保存…' : '保存映射'}</button></div></form></div>;
}

function PurchaseRequestModal({ demands, members, busy, error, onClose, onSubmit }: {
  demands: PurchaseDemand[]; members: PurchaseMember[]; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const totalQuantity = demands.reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const defaultBuyer = members[0]?.id ?? '';
  const defaultReviewer = members[1]?.id ?? defaultBuyer;
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-request-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>生成采购申请</h2><p>已选 {demands.length} 行，共 {totalQuantity} 件</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="purchase-selected-list">{demands.slice(0, 5).map((demand) => <div key={demand.id}><strong>{demand.mappedSkuCode ?? demand.rawSku ?? '未识别 SKU'}</strong><span>{demand.title ?? demand.name ?? demand.sourceOrderLineId}</span><b>{demandAvailableQuantity(demand)} 件</b></div>)}{demands.length > 5 && <small>另有 {demands.length - 5} 行已选需求</small>}</div><div className="form-grid"><label>采购负责人<select name="purchaserMemberId" defaultValue={defaultBuyer} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label>复审人<select name="reviewerMemberId" defaultValue={defaultReviewer} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label className="full">采购备注<textarea name="note" rows={3} maxLength={500} placeholder="可填写交期、供应商沟通或特殊要求" /></label>{!members.length && <div className="form-error full">当前没有可分配成员，请先让业务人员登录一次 ERP。</div>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>开发阶段</span>当前允许负责人和复审人为同一人；上线前可启用岗位分离。重复需求不会生成第二张有效申请。</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" value="draft" disabled={busy || !members.length}>{busy ? '处理中…' : '保存草稿'}</button><button className="primary-button" type="submit" value="submit" disabled={busy || !members.length}>{busy ? '处理中…' : '创建并提交复审'}</button></div></form></div>;
}

function Status({ status }: { status: OrderStatus }) {
  return <span className={`status-pill status-${status}`}>{statusLabel[status]}</span>;
}

function InventoryStatus({ available }: { available: number }) {
  const label = available === 0 ? '已售罄' : available <= 10 ? '库存偏低' : '库存充足';
  return <span className={`status-pill ${available === 0 ? 'danger' : available <= 10 ? '' : 'success'}`}>{label}</span>;
}

function AuthRequired() {
  return <div className="content auth-state"><div className="auth-card"><div className="auth-mark">易</div><p>身份验证</p><h1>登录后进入易仓 ERP</h1><span>订单、库存和审计数据仅向已验证用户开放。</span><a className="primary-button auth-button" href="/signin-with-chatgpt?return_to=/">使用 ChatGPT 登录</a></div></div>;
}

function LoadingState({ message = '正在建立安全业务上下文…' }: { message?: string }) {
  return <div className="content loading-state"><span className="loader" /><p>{message}</p></div>;
}

function normalizePurchaseWorkspace(body: PurchaseWorkspacePayload | PurchaseDemandsPayload): PurchaseWorkspacePayload {
  const demands = (body.demands ?? []).map((demand) => ({
    ...demand,
    allocatedQuantity: Math.max(0, demand.allocatedQuantity ?? 0),
    availableQuantity: Math.max(0, demand.availableQuantity ?? demand.requiredQuantity - (demand.allocatedQuantity ?? 0)),
  }));
  if ('requests' in body) {
    const requests = Array.isArray(body.requests) ? body.requests.map((request) => ({
      ...request,
      buyer: request.buyer ?? request.purchaser ?? (request.purchaserName ? {
        id: request.purchaserMemberId ?? '', displayName: request.purchaserName, role: 'operator' as const,
      } : null),
      reviewer: request.reviewer ?? (request.reviewerName ? {
        id: request.reviewerMemberId ?? '', displayName: request.reviewerName, role: 'operator' as const,
      } : null),
      creator: request.creator ?? (request.creatorName ? {
        id: '', displayName: request.creatorName, role: 'operator' as const,
      } : null),
      lines: Array.isArray(request.lines) ? request.lines.map((line) => ({
        ...line,
        demandId: line.demandId ?? (line as PurchaseRequestLine & { purchaseDemandId?: string }).purchaseDemandId ?? '',
      })) : [],
      lineCount: request.lineCount ?? request.lines?.length ?? 0,
      totalQuantity: request.totalQuantity ?? request.lines?.reduce((sum, line) => sum + line.requestedQuantity, 0) ?? 0,
      note: request.note ?? null,
      reviewNote: request.reviewNote ?? null,
      needsAttention: Boolean(request.needsAttention),
    })) : [];
    return {
      ...body,
      demands,
      summary: body.summary ?? emptyPurchaseSummary,
      requests,
      requestSummary: body.requestSummary ?? summarizePurchaseRequests(requests),
      members: Array.isArray(body.members) ? body.members : [],
      skuOptions: Array.isArray(body.skuOptions) ? body.skuOptions : [],
    };
  }
  return {
    ok: true,
    readOnly: true,
    demands,
    summary: body.summary ?? emptyPurchaseSummary,
    requests: [],
    requestSummary: emptyPurchaseRequestSummary,
    members: [],
    skuOptions: [],
  };
}

function summarizePurchaseRequests(requests: PurchaseRequest[]) {
  return requests.reduce((summary, request) => {
    summary.total += 1;
    if (request.status === 'pending_review') summary.pendingReview += 1;
    else summary[request.status] += 1;
    return summary;
  }, { ...emptyPurchaseRequestSummary });
}

function demandAvailableQuantity(demand: PurchaseDemand) {
  return Math.max(0, demand.availableQuantity ?? demand.requiredQuantity - (demand.allocatedQuantity ?? 0));
}

function formatMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amountMinor / 100);
}

function formatExactMoney(amount: string | null, currency: string | null) {
  if (amount === null || currency === null) return '未知';
  return `${currency} ${amount}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function formatOptionalQuantity(value: number | null) {
  return value === null ? '未知' : String(value);
}
