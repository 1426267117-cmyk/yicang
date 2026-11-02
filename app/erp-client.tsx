'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type ModuleKey = 'dashboard' | 'platform' | 'orders' | 'inventory' | 'purchase' | 'warehouse' | 'logistics' | 'finance' | 'reports';
type OrderStatus = 'pending_review' | 'reserved' | 'shipped' | 'cancelled';
type OrderAction = 'approve' | 'ship' | 'cancel';
type Permission = 'orders:read' | 'orders:create' | 'orders:approve' | 'orders:ship' | 'orders:cancel' | 'audit:read' | 'connectors:read' | 'connectors:sync' | 'purchase:read' | 'purchase:mapping' | 'purchase:create' | 'purchase:submit' | 'purchase:review' | 'purchase:supplier:create' | 'purchase:order:create' | 'purchase:order:issue' | 'inventory:receive' | 'warehouse:manage';

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
type PurchaseRequestAction = 'submit' | 'approve' | 'reject' | 'cancel' | 'withdraw';
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

type PurchaseSupplier = {
  id: string; code: string; name: string; note: string | null; active: boolean;
  version: number; createdAt: string; updatedAt: string;
};
type PurchaseWarehouse = { id: string; code: string; name: string };
type PurchaseOrderStatus = 'draft' | 'issued' | 'partially_received' | 'received' | 'cancelled';
type PurchaseOrderLine = {
  id: string; purchaseRequestLineId: string; skuId: string; skuCode: string; skuName: string;
  orderedQuantity: number; receivedQuantity: number; remainingQuantity: number;
  unitCostMinor: number | null; currency: string | null;
};
type PurchaseOrder = {
  id: string; orderNo: string; purchaseRequestId: string; purchaseRequestNo: string;
  supplier: Pick<PurchaseSupplier, 'id' | 'code' | 'name'>; status: PurchaseOrderStatus;
  currency: string | null; note: string | null; version: number; lineCount: number;
  orderedQuantity: number; receivedQuantity: number; issuedAt: string | null; cancelledAt: string | null;
  createdAt: string; updatedAt: string; lines: PurchaseOrderLine[];
};
type PurchaseReceiptLine = {
  id: string; purchaseOrderLineId: string; skuId: string; skuCode: string; skuName: string;
  warehouseId: string; quantity: number;
};
type PurchaseReceipt = {
  id: string; receiptNo: string; purchaseOrderId: string; purchaseOrderNo: string;
  warehouse: PurchaseWarehouse; status: 'posted'; note: string | null; receivedAt: string;
  createdAt: string; lineCount: number; totalQuantity: number; lines: PurchaseReceiptLine[];
};
type ProcurementSummary = {
  suppliers: number; draftOrders: number; issuedOrders: number; partiallyReceivedOrders: number;
  receivedOrders: number; pendingReceiptQuantity: number; receiptCount: number; receivedQuantity: number;
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
  currentMemberId: string | null; developmentOpenAccess: boolean;
  members: PurchaseMember[]; skuOptions: PurchaseSkuOption[];
  suppliers: PurchaseSupplier[]; warehouses: PurchaseWarehouse[]; purchaseOrders: PurchaseOrder[];
  purchaseReceipts: PurchaseReceipt[]; procurementSummary: ProcurementSummary;
};

type PurchasePlanningReason = { code: string; dataset?: string; message: string };
type PurchasePlanningFreshness = {
  checkedAt: string;
  status: 'fresh' | 'refreshing' | 'stale' | 'missing';
  readyForProcurement: boolean;
  maxAgeMinutes: number;
  needsRefresh: boolean; refreshDue: boolean; refreshInProgress: boolean;
  datasets: Array<{
    dataset: string; requiredForProcurement: boolean; fresh: boolean;
    generatedAt: string | null; lastSuccessAt: string | null; recordCount: number | null;
    reasons: PurchasePlanningReason[];
  }>;
  blockingReasons: PurchasePlanningReason[];
};
type PurchasePlanningOperations = {
  checkedAt: string;
  browserRefresh: {
    guaranteedCollection: false;
    shopifySyncTriggered: false;
    mukuDueRefreshMayTrigger: boolean;
    note: string;
  };
  internalJobAuthConfigured: boolean;
  automationReady: boolean;
  muku: {
    protectedEndpoint: string; endpointReady: boolean; sourceConfigured: boolean;
    externalScheduleConfigured: boolean; automationReady: boolean;
    recommendedIntervalMinutes: number; dataReady: boolean;
    sourceGeneratedAt: string | null; lastSuccessAt: string | null;
    freshUntil: string | null; nextRefreshDueAt: string | null;
    configurationBlockers: string[]; dataBlockers: string[];
  };
  shopify: {
    protectedEndpoint: string; endpointReady: boolean; sourceConfigured: boolean;
    externalScheduleConfigured: boolean; automationReady: boolean;
    recommendedIntervalMinutes: number; maxAgeMinutes: number;
    lastSuccessAt: string | null; nextExpiryAt: string | null;
    configurationBlockers: string[];
    stores: Array<{
      storeId: string; storeKey: string; storeName: string; ready: boolean;
      lastSuccessAt: string | null; ageMinutes: number | null; freshUntil: string | null;
      syncStatus: string; lastErrorCode: string | null; reasons: string[];
    }>;
  };
};
type PurchasePlanningRow = {
  planRowId: string; calculationVersion: string; recommendationVersion: string;
  skuId: string; skuCode: string; skuName: string;
  decision: 'buy' | 'no_purchase' | 'blocked';
  blockers: string[]; warnings: string[]; explanations: string[];
  mukuMatchStatus: 'manual' | 'exact' | 'unmapped' | 'ambiguous';
  ambiguousMukuSkus: string[];
  mukuSkus: Array<{
    sku: string; mappingSource: 'manual' | 'exact'; availableQty: number | null;
    inboundQty: number | null; sales30d: number | null; inventoryRecordCount: number;
    inventorySourceUpdatedAt: string | null; riskSourceUpdatedAt: string | null;
  }>;
  orderDemandQty: number; activeRequestQty: number; unallocatedDemandQty: number;
  mukuAvailableQty: number | null; effectiveAvailableQty: number | null;
  availableQtySource: 'muku' | 'manual_confirmation' | 'unknown';
  mukuInboundQty: number | null;
  inventoryScope: 'all_muku_warehouses';
  erpPurchaseChainCoverageQty: number; erpOpenPoQty: number; erpReceivedQty: number;
  sales30d: number | null; safetyDays: number; safetyStockQty: number | null;
  safetyStockBasis: 'explicit' | 'sales30d' | 'unknown';
  rawGapQty: number | null; recommendedQty: number | null;
  policy: {
    moq: number | null; packSize: number | null; leadTimeDays: number | null;
    preferredSupplierId: string | null; preferredSupplierName: string | null;
  };
  calculationParts: {
    orderDemandQty: number; safetyStockQty: number | null; mukuAvailableQty: number | null;
    effectiveAvailableQty: number | null;
    availableQtySource: 'muku' | 'manual_confirmation' | 'unknown';
    erpPurchaseChainCoverageQty: number; mukuInboundQty: number | null;
    mukuInboundDeducted: false; erpOpenPoDeductedSeparately: false;
    rawOrderGapQty: number | null; rawTotalGapQty: number | null;
    moq: number | null; packSize: number | null; roundedRecommendedQty: number | null;
  };
  sourceTimes: {
    inventoryGeneratedAt: string | null; inventoryLastSuccessAt: string | null;
    inventoryRecordUpdatedAt: string | null; riskGeneratedAt: string | null;
    riskLastSuccessAt: string | null; riskRecordUpdatedAt: string | null;
    inventoryOldestRecordUpdatedAt: string | null; inventorySourceMaxAgeMinutes: number;
    latestReceiptAt: string | null; receiptReflectedInMuku: boolean | null;
  };
  inventoryConfirmation: {
    id: string; confirmedAvailableQty: number; scope: 'all_warehouses';
    confirmedAt: string; expiresAt: string; note: string;
    confirmedBy: string; confirmedByEmail: string; active: boolean; used: boolean;
  } | null;
  conversion: {
    eligibleOrderQty: number; blockedRecommendationQty: number;
    safetyOnlyQty: number; policyRoundingQty: number;
    conversionBlocked: boolean; reasons: string[];
  };
  demandAllocations: Array<{ demandId: string; quantity: number }>;
};
type MukuPlanningException = {
  mukuSku: string; status: 'unmapped' | 'ambiguous'; candidateSkuIds: string[];
  availableQty: number | null; inboundQty: number | null;
};
type PurchasePlanningPayload = {
  ok: true; readOnly: true; readiness: 'ready' | 'blocked' | 'stale';
  orderSourceReadiness: boolean;
  orderSourceMaxAgeMinutes: number; orderSourceBlockers: string[];
  orderSources: Array<{
    storeId: string; platform: string; storeKey: string; storeName: string;
    official: boolean; ready: boolean; lastSuccessAt: string | null; ageMinutes: number | null;
    syncStatus: string; lastErrorCode: string | null; reasons: string[];
  }>;
  calculationVersion: string;
  formula: { target: string; coverage: string; recommendation: string; deduplication: string; mukuInbound: string };
  operations: PurchasePlanningOperations;
  freshness: PurchasePlanningFreshness;
  summary: {
    rows: number; buy: number; noPurchase: number; blocked: number;
    recommendedQty: number | null; knownRecommendedQty: number; unknownRecommendationRows: number;
    convertibleOrderQty: number;
    needsShopifyMapping: number; needsMukuMapping: number;
  };
  rows: PurchasePlanningRow[];
  mappingExceptions: {
    shopify: Array<{ demandId: string; platform: string; rawSku: string | null; requiredQuantity: number; sourceOrderId: string }>;
    muku: MukuPlanningException[];
    erp: Array<{ planRowId: string; skuId: string; skuCode: string; status: 'unmapped' | 'ambiguous'; ambiguousMukuSkus: string[] }>;
  };
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

type InventorySourceTab = 'erp' | 'muku' | 'risk';
type MukuFilters = { sku: string; warehouse: string };
type MukuSyncStatus = 'unconfigured' | 'idle' | 'running' | 'succeeded' | 'failed' | 'stale' | 'unknown';
type MukuDatasetState = {
  dataset: string;
  status: string;
  apiVersion: string | null;
  generatedAt: string | null;
  recordCount: number | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string | null;
};
type MukuStatus = {
  ok: true;
  configured: boolean;
  connected: boolean;
  readOnly: true;
  apiVersion: string | null;
  datasetCount: number;
  status: MukuSyncStatus;
  errorCode: string | null;
  lastSuccessAt: string | null;
  sourceGeneratedAt: string | null;
  syncedAt: string | null;
  datasets: MukuDatasetState[];
  sourceStatusCount: number;
  autoRefresh?: { mode: string; refreshTriggered: boolean; externalScheduleConfigured: boolean };
};
type MukuRun = {
  id: string;
  dataset: string;
  status: string;
  recordCount: number | null;
  pageCount: number | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  replayed: boolean | null;
};
type MukuRunsPayload = { records: MukuRun[]; pagination: MukuPagination };
type MukuPagination = { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean };
type MukuInventoryRow = {
  id: string;
  recordKey: string | null;
  sku: string | null;
  normalizedSku: string | null;
  productName: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  available: number | null;
  locked: number | null;
  onHand: number | null;
  inTransit: number | null;
  ageDays: number | null;
  sourceUpdatedAt: string | null;
  ingestedAt: string | null;
};
type MukuRiskRow = {
  id: string;
  sku: string | null;
  normalizedSku: string | null;
  slowMoving: boolean | null;
  overAge: boolean | null;
  activeLowStock: boolean | null;
  reasons: string[];
  available: number | null;
  locked: number | null;
  onHand: number | null;
  sales30d: number | null;
  ageDays: number | null;
  sourceUpdatedAt: string | null;
};
type MukuInventoryPayload = {
  ok: true;
  stale: boolean;
  snapshotId: string | null;
  generatedAt: string | null;
  sourceUpdatedAt: string | null;
  syncedAt: string | null;
  errorCode: string | null;
  pagination: MukuPagination;
  records: MukuInventoryRow[];
};
type MukuRiskPayload = {
  ok: true;
  stale: boolean;
  generatedAt: string | null;
  sourceUpdatedAt: string | null;
  syncedAt: string | null;
  errorCode: string | null;
  pagination: MukuPagination;
  records: MukuRiskRow[];
};

type OAuthFailureNotice = { message: string; retryUrl: string };

const shopifyOAuthFailureMessages: Record<string, string> = {
  AUTH_REQUIRED: 'ERP 登录状态已失效，请重新登录后再授权 Shopify。',
  ERP_ACCESS_POLICY_REQUIRED: 'ERP 正式访问名单尚未配置，请先由管理员完成上线配置。',
  ERP_ACCESS_NOT_ALLOWED: '当前账号不在 ERP 正式访问名单中，请联系管理员添加后重试。',
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
  MAP_PURCHASE_SKU: '映射采购 SKU', CREATE_PURCHASE_REQUEST: '创建采购申请',
  SUBMIT_PURCHASE_REQUEST: '提交采购复审', APPROVE_PURCHASE_REQUEST: '批准采购申请',
  REJECT_PURCHASE_REQUEST: '驳回采购申请', CANCEL_PURCHASE_REQUEST: '取消采购申请',
  WITHDRAW_PURCHASE_REQUEST: '撤回已批准采购申请',
  CREATE_SUPPLIER: '新增供应商', CREATE_WAREHOUSE: '新增仓库', CREATE_PURCHASE_ORDER: '生成正式采购单',
  ISSUE_PURCHASE_ORDER: '确认采购下单', CANCEL_PURCHASE_ORDER: '取消采购单',
  POST_PURCHASE_RECEIPT: '采购到货入库',
  UPSERT_MUKU_SKU_MAPPING: '维护 MUKU SKU 映射', UPSERT_SKU_PROCUREMENT_POLICY: '维护采购策略',
  CREATE_PURCHASE_REQUEST_FROM_PLAN: '采购建议转申请',
};

const purchaseDemandStatusLabel: Record<PurchaseDemandStatus, string> = {
  needs_mapping: '待 SKU 映射', open: '开放需求', not_required: '无需采购',
};

const purchaseDemandReasonLabel: Record<string, string> = {
  line_removed: '订单行已移除', test_order: '测试订单', cancelled_order: '订单已取消',
  fulfilled_order: '订单已履约', no_unfulfilled_quantity: '无未履约数量', sku_missing: '订单行缺少 SKU',
  sku_ambiguous: 'SKU 映射存在歧义', sku_unmapped: 'SKU 尚未映射',
  non_stock_shipping_protection: '运费保障服务，无需采购',
  non_stock_assembly_fee: '安装服务费，无需采购',
};

const purchaseRequestStatusLabel: Record<PurchaseRequestStatus, string> = {
  draft: '草稿', pending_review: '待复审', approved: '已批准', rejected: '已驳回', cancelled: '已取消',
};

const purchaseOrderStatusLabel: Record<PurchaseOrderStatus, string> = {
  draft: '草稿', issued: '已下单', partially_received: '部分到货', received: '全部到货', cancelled: '已取消',
};

type PurchaseTab = 'planning' | 'pending' | 'mapping' | 'requests' | 'approved' | 'orders' | 'received' | 'history';

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

const emptyProcurementSummary: ProcurementSummary = {
  suppliers: 0, draftOrders: 0, issuedOrders: 0, partiallyReceivedOrders: 0,
  receivedOrders: 0, pendingReceiptQuantity: 0, receiptCount: 0, receivedQuantity: 0,
};

export default function ErpClient() {
  const [active, setActive] = useState<ModuleKey>('dashboard');
  const [payload, setPayload] = useState<ErpPayload | null>(null);
  const [purchasePayload, setPurchasePayload] = useState<PurchaseWorkspacePayload | null>(null);
  const [purchasePlanning, setPurchasePlanning] = useState<PurchasePlanningPayload | null>(null);
  const [planningError, setPlanningError] = useState('');
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
  const [inventorySource, setInventorySource] = useState<InventorySourceTab>('erp');
  const [mukuStatus, setMukuStatus] = useState<MukuStatus | null>(null);
  const [mukuRuns, setMukuRuns] = useState<MukuRunsPayload | null>(null);
  const [mukuInventory, setMukuInventory] = useState<MukuInventoryPayload | null>(null);
  const [mukuRisk, setMukuRisk] = useState<MukuRiskPayload | null>(null);
  const [mukuPage, setMukuPage] = useState(1);
  const [mukuFilters, setMukuFilters] = useState<MukuFilters>({ sku: '', warehouse: '' });
  const [mukuBusy, setMukuBusy] = useState('');
  const [mukuError, setMukuError] = useState('');
  const [mukuRefreshKey, setMukuRefreshKey] = useState(0);
  const [purchaseTab, setPurchaseTab] = useState<PurchaseTab>('planning');
  const [selectedDemandIds, setSelectedDemandIds] = useState<Set<string>>(new Set());
  const [selectedPlanRowIds, setSelectedPlanRowIds] = useState<Set<string>>(new Set());
  const [mappingDemand, setMappingDemand] = useState<PurchaseDemand | null>(null);
  const [planningMapping, setPlanningMapping] = useState<MukuPlanningException | null>(null);
  const [planningPolicy, setPlanningPolicy] = useState<PurchasePlanningRow | null>(null);
  const [inventoryConfirmationRow, setInventoryConfirmationRow] = useState<PurchasePlanningRow | null>(null);
  const [showPurchaseRequest, setShowPurchaseRequest] = useState(false);
  const [showPlanningRequest, setShowPlanningRequest] = useState(false);
  const [showSupplier, setShowSupplier] = useState(false);
  const [showWarehouse, setShowWarehouse] = useState(false);
  const [purchaseOrderRequest, setPurchaseOrderRequest] = useState<PurchaseRequest | null>(null);
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
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
      const planningResponse = await fetch('/api/purchase/planning', { cache: 'no-store' });
      const planningBody = await planningResponse.json().catch(() => null) as PurchasePlanningPayload | { message?: string } | null;
      if (planningResponse.status === 401) { setAuthRequired(true); return; }
      if (planningResponse.ok && planningBody && 'ok' in planningBody && planningBody.ok === true) {
        setPurchasePlanning(planningBody);
        setPlanningError('');
        setSelectedPlanRowIds((current) => new Set([...current].filter((id) => planningBody.rows.some(
          (row) => row.planRowId === id && planningRowConvertible(row, planningBody.readiness, planningBody.orderSourceReadiness),
        ))));
      } else {
        setPlanningError(readApiMessage(planningBody, '采购建议暂时无法计算，现有申请和采购单仍可正常使用'));
      }
      const connectorResponse = await fetch('/api/connectors/shopify/status', { cache: 'no-store' });
      if (connectorResponse.ok) setShopifyStatus(await connectorResponse.json() as ShopifyStatus);
      if (body.user.permissions.includes('connectors:read')) {
        const mukuStatusResponse = await fetch('/api/connectors/muku/status', { cache: 'no-store' });
        if (mukuStatusResponse.ok) {
          setMukuStatus(normalizeMukuStatus(await mukuStatusResponse.json()));
        }
        const mukuRunsResponse = await fetch('/api/connectors/muku/runs?page=1&pageSize=8', { cache: 'no-store' });
        if (mukuRunsResponse.ok) setMukuRuns(normalizeMukuRuns(await mukuRunsResponse.json()));
      }
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

  const shouldPollPurchasePlanning = active === 'purchase' && Boolean(
    purchasePlanning && !purchasePlanning.freshness.readyForProcurement
    && (purchasePlanning.freshness.refreshInProgress
      || purchasePlanning.freshness.refreshDue
      || mukuStatus?.autoRefresh?.refreshTriggered),
  );

  useEffect(() => {
    if (!shouldPollPurchasePlanning) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const [planningResponse, statusResponse] = await Promise.all([
          fetch('/api/purchase/planning', { cache: 'no-store' }),
          fetch('/api/connectors/muku/status', { cache: 'no-store' }),
        ]);
        const planningBody = await planningResponse.json().catch(() => null) as PurchasePlanningPayload | null;
        const statusBody = await statusResponse.json().catch(() => null);
        if (cancelled) return;
        if (statusResponse.ok) setMukuStatus(normalizeMukuStatus(statusBody));
        if (planningResponse.ok && planningBody?.ok === true) {
          setPurchasePlanning(planningBody);
          setSelectedPlanRowIds((current) => new Set([...current].filter((id) => planningBody.rows.some(
            (row) => row.planRowId === id && planningRowConvertible(row, planningBody.readiness, planningBody.orderSourceReadiness),
          ))));
          if (planningBody.freshness.readyForProcurement) {
            setPlanningError('');
            return;
          }
        }
      } catch {
        // 保留上一份有效建议；轮询窗口内继续尝试。
      }
      if (attempts < 8) {
        timer = window.setTimeout(() => { void poll(); }, 5000);
      } else if (!cancelled) {
        setPlanningError('MUKU 后台刷新尚未在 40 秒内完成，已保留上一版建议；数据恢复新鲜前不能转采购申请。');
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shouldPollPurchasePlanning]);

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

  useEffect(() => {
    if (active !== 'inventory' || inventorySource === 'erp' || !payload?.user.permissions.includes('connectors:read')) return undefined;
    let cancelled = false;
    const parameters = new URLSearchParams({ page: String(mukuPage), pageSize: '100' });
    if (mukuFilters.sku) parameters.set('sku', mukuFilters.sku);
    if (inventorySource === 'muku' && mukuFilters.warehouse) parameters.set('warehouse', mukuFilters.warehouse);
    const endpoint = inventorySource === 'muku'
      ? `/api/connectors/muku/inventory?${parameters}`
      : `/api/connectors/muku/risk?${parameters}`;
    const busyKey = inventorySource === 'muku' ? 'inventory' : 'risk';
    const load = async () => {
      setMukuBusy(busyKey);
      setMukuError('');
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(readApiMessage(body, 'MUKU 只读快照加载失败'));
        if (cancelled) return;
        if (inventorySource === 'muku') setMukuInventory(normalizeMukuInventory(body));
        else setMukuRisk(normalizeMukuRisk(body));
      } catch (cause) {
        if (!cancelled) setMukuError(cause instanceof Error ? cause.message : 'MUKU 只读快照加载失败');
      } finally {
        if (!cancelled) setMukuBusy('');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [active, inventorySource, mukuFilters, mukuPage, mukuRefreshKey, payload]);

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
  const filteredMukuInventory = useMemo(() => {
    const records = mukuInventory?.records ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return records;
    return records.filter((item) => [
      item.sku ?? '', item.normalizedSku ?? '', item.productName ?? '',
      item.warehouseCode ?? '', item.warehouseName ?? '', item.recordKey ?? '',
    ].some((value) => value.toLowerCase().includes(term)));
  }, [mukuInventory, query]);
  const filteredMukuRisk = useMemo(() => {
    const records = mukuRisk?.records ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return records;
    return records.filter((item) => [
      item.sku ?? '', item.normalizedSku ?? '', ...item.reasons,
    ].some((value) => value.toLowerCase().includes(term)));
  }, [mukuRisk, query]);
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
  const filteredPurchasePlanningRows = useMemo(() => {
    const rows = purchasePlanning?.rows ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [
      row.skuCode,
      row.skuName,
      ...row.mukuSkus.map((source) => source.sku),
      ...row.blockers.map(planningReasonLabel),
      ...row.warnings.map(planningReasonLabel),
    ].some((value) => value.toLowerCase().includes(term)));
  }, [purchasePlanning, query]);
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
  const filteredPurchaseOrders = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return purchasePayload?.purchaseOrders ?? [];
    return (purchasePayload?.purchaseOrders ?? []).filter((order) => [
      order.orderNo,
      order.purchaseRequestNo,
      order.supplier.code,
      order.supplier.name,
      purchaseOrderStatusLabel[order.status],
      order.currency ?? '',
      order.note ?? '',
      ...order.lines.flatMap((line) => [line.skuCode, line.skuName]),
    ].some((value) => value.toLowerCase().includes(term)));
  }, [purchasePayload, query]);
  const filteredPurchaseReceipts = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return purchasePayload?.purchaseReceipts ?? [];
    return (purchasePayload?.purchaseReceipts ?? []).filter((receipt) => [
      receipt.receiptNo,
      receipt.purchaseOrderNo,
      receipt.warehouse.code,
      receipt.warehouse.name,
      receipt.note ?? '',
      ...receipt.lines.flatMap((line) => [line.skuCode, line.skuName]),
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

  async function refreshMukuDiagnostics() {
    const statusResponse = await fetch('/api/connectors/muku/status', { cache: 'no-store' }).catch(() => null);
    const runsResponse = await fetch('/api/connectors/muku/runs?page=1&pageSize=8', { cache: 'no-store' }).catch(() => null);
    if (runsResponse?.ok) setMukuRuns(normalizeMukuRuns(await runsResponse.json()));
    return statusResponse?.ok ? normalizeMukuStatus(await statusResponse.json()) : null;
  }

  async function testMukuConnection() {
    if (mukuBusy) return;
    setMukuBusy('test'); setMukuError('');
    try {
      const response = await fetch('/api/connectors/muku/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || asObject(body).ok !== true) throw new Error(readApiMessage(body, 'MUKU 连接测试失败'));
      const actionStatus = normalizeMukuStatus(body);
      const refreshedStatus = await refreshMukuDiagnostics() ?? actionStatus;
      setMukuStatus(refreshedStatus.configured ? refreshedStatus : actionStatus);
      flash('MUKU 只读连接正常；测试未修改看板或 ERP 库存');
    } catch (cause) {
      setMukuError(cause instanceof Error ? cause.message : 'MUKU 连接测试失败');
    } finally { setMukuBusy(''); }
  }

  async function syncMukuReadOnly() {
    if (mukuBusy) return;
    setMukuBusy('sync'); setMukuError('');
    try {
      const response = await fetch('/api/connectors/muku/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ datasets: ['source-status', 'inventory', 'inventory-details', 'inventory-risk'] }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || asObject(body).ok !== true) throw new Error(readApiMessage(body, 'MUKU 只读同步失败；已保留上次有效快照'));
      const refreshedStatus = await refreshMukuDiagnostics() ?? normalizeMukuStatus(body);
      setMukuStatus((current) => refreshedStatus.configured ? refreshedStatus : current ?? refreshedStatus);
      setMukuRefreshKey((current) => current + 1);
      flash('MUKU 只读快照同步完成；ERP 库存账本未被覆盖');
    } catch (cause) {
      setMukuError(cause instanceof Error ? cause.message : 'MUKU 只读同步失败');
      const refreshedStatus = await refreshMukuDiagnostics();
      if (refreshedStatus) setMukuStatus(refreshedStatus);
    } finally { setMukuBusy(''); }
  }

  function switchInventorySource(source: InventorySourceTab) {
    setInventorySource(source);
    setMukuPage(1);
    setMukuError('');
  }

  function applyMukuFilters(filters: MukuFilters) {
    setMukuFilters({ sku: filters.sku.trim(), warehouse: filters.warehouse.trim() });
    setMukuPage(1);
  }

  function togglePurchaseDemand(id: string) {
    setSelectedDemandIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function togglePlanningRow(id: string) {
    setSelectedPlanRowIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submitPlanningMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planningMapping) return;
    const data = new FormData(event.currentTarget);
    setPurchaseBusy(`planning-mapping:${planningMapping.mukuSku}`); setError('');
    try {
      const response = await fetch('/api/purchase/planning/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          mukuSku: planningMapping.mukuSku,
          skuId: String(data.get('skuId') ?? ''),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readApiMessage(body, 'MUKU SKU 映射失败'));
      setPlanningMapping(null);
      await loadData();
      flash('MUKU SKU 已映射，采购建议已重新计算');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'MUKU SKU 映射失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitPlanningPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planningPolicy) return;
    const data = new FormData(event.currentTarget);
    setPurchaseBusy(`planning-policy:${planningPolicy.skuId}`); setError('');
    try {
      const response = await fetch('/api/purchase/planning/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          skuId: planningPolicy.skuId,
          safetyDays: Number(data.get('safetyDays')),
          safetyStockQty: optionalFormInteger(data, 'safetyStockQty'),
          moq: optionalFormInteger(data, 'moq'),
          packSize: optionalFormInteger(data, 'packSize'),
          leadTimeDays: optionalFormInteger(data, 'leadTimeDays'),
          preferredSupplierId: String(data.get('preferredSupplierId') ?? '').trim() || null,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readApiMessage(body, '采购策略保存失败'));
      setPlanningPolicy(null);
      await loadData();
      flash('采购策略已保存，建议数量已重新计算');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购策略保存失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitInventoryConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inventoryConfirmationRow) return;
    if (!manualInventoryConfirmationEligible(inventoryConfirmationRow)) {
      setError('只有 MUKU 可用库存未知且映射无歧义时，才能录入人工库存确认');
      return;
    }
    const data = new FormData(event.currentTarget);
    const quantityText = String(data.get('confirmedAvailableQty') ?? '').trim();
    const confirmedAvailableQty = Number(quantityText);
    const note = String(data.get('note') ?? '').trim();
    if (!/^\d+$/.test(quantityText) || !Number.isSafeInteger(confirmedAvailableQty)) {
      setError('仓库可用库存必须是大于或等于 0 的整数');
      return;
    }
    if (note.length < 3) {
      setError('请填写至少 3 个字的核对说明');
      return;
    }
    const renewing = Boolean(inventoryConfirmationRow.inventoryConfirmation);
    setPurchaseBusy(`planning-inventory:${inventoryConfirmationRow.skuId}`); setError('');
    try {
      const response = await fetch('/api/purchase/planning/inventory-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          skuId: inventoryConfirmationRow.skuId,
          confirmedAvailableQty,
          note,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readApiMessage(body, '人工库存确认保存失败'));
      setInventoryConfirmationRow(null);
      await loadData();
      flash(renewing ? '人工库存确认已更新并续期 24 小时' : '人工库存确认已保存，24 小时内可作为缺失值兜底');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '人工库存确认保存失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitPlanningRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!purchasePlanning) return;
    const data = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === 'submit' ? 'submit' : 'draft';
    const selections = purchasePlanning.rows
      .filter((row) => selectedPlanRowIds.has(row.planRowId))
      .map((row) => ({ planRowId: row.planRowId, recommendationVersion: row.recommendationVersion }));
    setPurchaseBusy('create-planning-request'); setError('');
    try {
      const response = await fetch('/api/purchase/planning/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          selections,
          purchaserMemberId: String(data.get('purchaserMemberId') ?? ''),
          reviewerMemberId: String(data.get('reviewerMemberId') ?? ''),
          note: String(data.get('note') ?? '').trim() || undefined,
        }),
      });
      const body = await response.json().catch(() => null) as { message?: string; request?: { id?: string } } | null;
      if (!response.ok) {
        if (response.status === 409) await loadData();
        throw new Error(readApiMessage(body, response.status === 409
          ? '建议依据已经变化，页面已刷新，请重新确认'
          : '采购建议转申请失败'));
      }
      if (intent === 'submit') {
        if (!body?.request?.id) throw new Error('采购申请已创建，但返回结果缺少申请标识，请刷新后提交');
        const submitResponse = await fetch(`/api/purchase/requests/${body.request.id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ action: 'submit' }),
        });
        const submitBody = await submitResponse.json().catch(() => null);
        if (!submitResponse.ok) throw new Error(readApiMessage(submitBody, '采购申请已保存为草稿，但提交复审失败'));
      }
      setShowPlanningRequest(false); setSelectedPlanRowIds(new Set());
      await loadData(); setPurchaseTab('requests');
      flash(intent === 'submit' ? '订单采购缺口已生成申请并提交复审' : '订单采购缺口已保存为申请草稿');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购建议转申请失败');
    } finally { setPurchaseBusy(''); }
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

  async function runPurchaseRequestAction(request: PurchaseRequest, action: PurchaseRequestAction) {
    let note = '';
    if (action === 'reject' || action === 'withdraw') {
      const reason = window.prompt(action === 'reject'
        ? `请输入驳回 ${request.requestNo} 的原因，需求将被释放但历史不会删除：`
        : `请输入撤回 ${request.requestNo} 的原因。仅在尚未生成有效采购单时可撤回，需求会释放并重新计算：`);
      if (reason === null) return;
      note = reason.trim();
      if (!note) { setError(action === 'reject' ? '驳回时必须填写原因' : '撤回时必须填写原因'); return; }
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
      flash(action === 'submit'
        ? '已提交复审'
        : action === 'approve'
          ? '复审已批准'
          : action === 'reject'
            ? '已驳回并释放需求'
            : action === 'withdraw'
              ? '已撤回批准申请，需求已释放并重新计算'
              : '草稿已取消并释放需求');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购申请操作失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPurchaseBusy('create-supplier'); setError('');
    try {
      const response = await fetch('/api/purchase/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          code: String(data.get('code') ?? '').trim(),
          name: String(data.get('name') ?? '').trim(),
          note: String(data.get('note') ?? '').trim() || undefined,
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '供应商创建失败');
      form.reset(); setShowSupplier(false); await loadData();
      flash('供应商已保存，可以用于正式采购单');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '供应商创建失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitWarehouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPurchaseBusy('create-warehouse'); setError('');
    try {
      const response = await fetch('/api/purchase/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          code: String(data.get('code') ?? '').trim(),
          name: String(data.get('name') ?? '').trim(),
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '仓库创建失败');
      form.reset(); setShowWarehouse(false); await loadData();
      flash('仓库已保存，可以继续登记采购到货');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '仓库创建失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitPurchaseOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!purchaseOrderRequest) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const lineCosts = purchaseOrderRequest.lines.flatMap((line) => {
      const rawValue = String(data.get(`unitCost:${line.id}`) ?? '').trim();
      return rawValue ? [{
        purchaseRequestLineId: line.id,
        unitCostMinor: Math.round(Number(rawValue) * 100),
      }] : [];
    });
    if (lineCosts.some((line) => !Number.isSafeInteger(line.unitCostMinor) || line.unitCostMinor < 0)) {
      setError('请填写有效的采购单价');
      return;
    }
    setPurchaseBusy(`create-order:${purchaseOrderRequest.id}`); setError('');
    try {
      const response = await fetch('/api/purchase/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          purchaseRequestId: purchaseOrderRequest.id,
          supplierId: String(data.get('supplierId') ?? ''),
          currency: String(data.get('currency') ?? 'CNY'),
          note: String(data.get('note') ?? '').trim() || undefined,
          lineCosts: lineCosts.length ? lineCosts : undefined,
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '正式采购单生成失败');
      setPurchaseOrderRequest(null); await loadData(); setPurchaseTab('orders');
      flash('正式采购单已生成，确认下单后可登记到货');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '正式采购单生成失败');
    } finally { setPurchaseBusy(''); }
  }

  async function runPurchaseOrderAction(order: PurchaseOrder, action: 'issue' | 'cancel') {
    const message = action === 'issue'
      ? `确认将 ${order.orderNo} 标记为已向 ${order.supplier.name} 下单？`
      : `确认取消 ${order.orderNo}？采购单和操作历史会保留。`;
    if (!window.confirm(message)) return;
    setPurchaseBusy(`${order.id}:${action}`); setError('');
    try {
      const response = await fetch(`/api/purchase/orders/${order.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ action }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '采购单操作失败');
      await loadData();
      flash(action === 'issue' ? '采购单已确认下单，等待到货' : '采购单已取消，历史仍然保留');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采购单操作失败');
    } finally { setPurchaseBusy(''); }
  }

  async function submitPurchaseReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receivingOrder) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const lines = receivingOrder.lines.map((line) => ({
      purchaseOrderLineId: line.id,
      quantity: Number(data.get(`quantity:${line.id}`) ?? 0),
    })).filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
    if (!lines.length) { setError('请至少填写一项本次实际到货数量'); return; }
    const receivedAtValue = String(data.get('receivedAt') ?? '').trim();
    const receivedAt = receivedAtValue ? new Date(receivedAtValue).toISOString() : undefined;
    setPurchaseBusy(`receive:${receivingOrder.id}`); setError('');
    try {
      const response = await fetch(`/api/purchase/orders/${receivingOrder.id}/receipts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          warehouseId: String(data.get('warehouseId') ?? ''),
          receivedAt,
          note: String(data.get('note') ?? '').trim() || undefined,
          lines,
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '到货入库失败');
      setReceivingOrder(null); await loadData(); setPurchaseTab('orders');
      flash('本次到货已登记，ERP 现存库存和入库流水已更新');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '到货入库失败');
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
            {active === 'inventory' && <InventoryView inventory={filteredInventory} summary={payload.summary} hasInventoryData={payload.inventory.length > 0} hasQuery={Boolean(query.trim())} source={inventorySource} setSource={switchInventorySource} mukuStatus={mukuStatus} mukuRuns={mukuRuns} mukuInventory={mukuInventory} mukuRisk={mukuRisk} mukuInventoryRows={filteredMukuInventory} mukuRiskRows={filteredMukuRisk} mukuPage={mukuPage} setMukuPage={setMukuPage} mukuFilters={mukuFilters} applyMukuFilters={applyMukuFilters} mukuBusy={mukuBusy} mukuError={mukuError} canRead={can('connectors:read')} canSync={can('connectors:sync')} testConnection={testMukuConnection} syncReadOnly={syncMukuReadOnly} />}
            {active === 'purchase' && <PurchaseWorkspaceView planning={purchasePlanning} planningRows={filteredPurchasePlanningRows} planningError={planningError} demands={filteredPurchaseDemands} requests={filteredPurchaseRequests} purchaseOrders={filteredPurchaseOrders} purchaseReceipts={filteredPurchaseReceipts} workspace={purchasePayload} tab={purchaseTab} setTab={setPurchaseTab} selectedPlanRowIds={selectedPlanRowIds} togglePlanningRow={togglePlanningRow} openPlanningRequest={() => setShowPlanningRequest(true)} openPlanningMapping={setPlanningMapping} openPlanningPolicy={setPlanningPolicy} openInventoryConfirmation={setInventoryConfirmationRow} selectedDemandIds={selectedDemandIds} toggleDemand={togglePurchaseDemand} openMapping={setMappingDemand} openRequest={() => setShowPurchaseRequest(true)} openSupplier={() => setShowSupplier(true)} openWarehouse={() => setShowWarehouse(true)} openPurchaseOrder={setPurchaseOrderRequest} openReceipt={setReceivingOrder} can={can} busy={purchaseBusy} runAction={runPurchaseRequestAction} runOrderAction={runPurchaseOrderAction} hasQuery={Boolean(query.trim())} />}
            {!['dashboard','platform','orders','inventory','purchase'].includes(active) && <PlannedModule module={plannedModules[active as keyof typeof plannedModules]} />}
          </>
        ) : <LoadingState message={error || '暂时无法加载业务数据'} />}
      </section>

      {showOrder && payload && <OrderModal inventory={payload.inventory} submitting={submitting} error={error} onClose={() => { if (!submitting) { setShowOrder(false); setError(''); } }} onSubmit={submitOrder} />}
      {mappingDemand && purchasePayload && <SkuMappingModal demand={mappingDemand} skuOptions={purchasePayload.skuOptions} busy={purchaseBusy.startsWith('mapping:')} error={error} onClose={() => { if (!purchaseBusy) { setMappingDemand(null); setError(''); } }} onSubmit={submitSkuMapping} />}
      {planningMapping && purchasePayload && <MukuPlanningMappingModal exception={planningMapping} skuOptions={purchasePayload.skuOptions} busy={purchaseBusy.startsWith('planning-mapping:')} error={error} onClose={() => { if (!purchaseBusy) { setPlanningMapping(null); setError(''); } }} onSubmit={submitPlanningMapping} />}
      {planningPolicy && purchasePayload && <PlanningPolicyModal row={planningPolicy} suppliers={purchasePayload.suppliers} busy={purchaseBusy.startsWith('planning-policy:')} error={error} onClose={() => { if (!purchaseBusy) { setPlanningPolicy(null); setError(''); } }} onSubmit={submitPlanningPolicy} />}
      {inventoryConfirmationRow && <InventoryConfirmationModal row={inventoryConfirmationRow} busy={purchaseBusy.startsWith('planning-inventory:')} error={error} onClose={() => { if (!purchaseBusy) { setInventoryConfirmationRow(null); setError(''); } }} onSubmit={submitInventoryConfirmation} />}
      {showPlanningRequest && purchasePlanning && purchasePayload && <PlanningRequestModal rows={purchasePlanning.rows.filter((row) => selectedPlanRowIds.has(row.planRowId))} members={purchasePayload.members} developmentOpenAccess={purchasePayload.developmentOpenAccess} busy={purchaseBusy === 'create-planning-request'} error={error} onClose={() => { if (!purchaseBusy) { setShowPlanningRequest(false); setError(''); } }} onSubmit={submitPlanningRequest} />}
      {showPurchaseRequest && purchasePayload && <PurchaseRequestModal demands={purchasePayload.demands.filter((demand) => selectedDemandIds.has(demand.id))} members={purchasePayload.members} developmentOpenAccess={purchasePayload.developmentOpenAccess} busy={purchaseBusy === 'create-request'} error={error} onClose={() => { if (!purchaseBusy) { setShowPurchaseRequest(false); setError(''); } }} onSubmit={submitPurchaseRequest} />}
      {showSupplier && <SupplierModal busy={purchaseBusy === 'create-supplier'} error={error} onClose={() => { if (!purchaseBusy) { setShowSupplier(false); setError(''); } }} onSubmit={submitSupplier} />}
      {showWarehouse && <WarehouseModal busy={purchaseBusy === 'create-warehouse'} error={error} onClose={() => { if (!purchaseBusy) { setShowWarehouse(false); setError(''); } }} onSubmit={submitWarehouse} />}
      {purchaseOrderRequest && purchasePayload && <PurchaseOrderModal request={purchaseOrderRequest} suppliers={purchasePayload.suppliers} busy={purchaseBusy.startsWith('create-order:')} error={error} openSupplier={() => setShowSupplier(true)} onClose={() => { if (!purchaseBusy) { setPurchaseOrderRequest(null); setError(''); } }} onSubmit={submitPurchaseOrder} />}
      {receivingOrder && purchasePayload && <PurchaseReceiptModal order={receivingOrder} warehouses={purchasePayload.warehouses} busy={purchaseBusy.startsWith('receive:')} error={error} canCreateWarehouse={can('warehouse:manage')} openWarehouse={() => setShowWarehouse(true)} onClose={() => { if (!purchaseBusy) { setReceivingOrder(null); setError(''); } }} onSubmit={submitPurchaseReceipt} />}
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

function InventoryView({ inventory, summary, hasInventoryData, hasQuery, source, setSource, mukuStatus, mukuRuns, mukuInventory, mukuRisk, mukuInventoryRows, mukuRiskRows, mukuPage, setMukuPage, mukuFilters, applyMukuFilters, mukuBusy, mukuError, canRead, canSync, testConnection, syncReadOnly }: {
  inventory: Inventory[];
  summary: ErpPayload['summary'];
  hasInventoryData: boolean;
  hasQuery: boolean;
  source: InventorySourceTab;
  setSource: (source: InventorySourceTab) => void;
  mukuStatus: MukuStatus | null;
  mukuRuns: MukuRunsPayload | null;
  mukuInventory: MukuInventoryPayload | null;
  mukuRisk: MukuRiskPayload | null;
  mukuInventoryRows: MukuInventoryRow[];
  mukuRiskRows: MukuRiskRow[];
  mukuPage: number;
  setMukuPage: (page: number) => void;
  mukuFilters: MukuFilters;
  applyMukuFilters: (filters: MukuFilters) => void;
  mukuBusy: string;
  mukuError: string;
  canRead: boolean;
  canSync: boolean;
  testConnection: () => void;
  syncReadOnly: () => void;
}) {
  const [filterDraft, setFilterDraft] = useState<MukuFilters>(mukuFilters);
  const totalOnHand = inventory.reduce((sum, item) => sum + item.onHandQty, 0);
  const totalReserved = inventory.reduce((sum, item) => sum + item.reservedQty, 0);
  const mukuKnownAvailable = mukuInventoryRows.reduce((sum, item) => sum + (item.available ?? 0), 0);
  const mukuKnownTransit = mukuInventoryRows.reduce((sum, item) => sum + (item.inTransit ?? 0), 0);
  const mukuAvailableSummary = !mukuInventory ? '未知' : !mukuInventoryRows.length ? '0' : mukuInventoryRows.some((item) => item.available !== null) ? String(mukuKnownAvailable) : '未知';
  const mukuTransitSummary = !mukuInventory ? '未知' : !mukuInventoryRows.length ? '0' : mukuInventoryRows.some((item) => item.inTransit !== null) ? String(mukuKnownTransit) : '未知';
  const mukuUnknownRows = mukuInventoryRows.filter((item) => item.sku === null || item.warehouseName === null || item.available === null).length;
  const slowMoving = mukuRiskRows.filter((item) => item.slowMoving === true).length;
  const overAge = mukuRiskRows.filter((item) => item.overAge === true).length;
  const lowStock = mukuRiskRows.filter((item) => item.activeLowStock === true).length;
  const stats = source === 'erp'
    ? [['库存记录', String(inventory.length), 'SKU × 仓库'], ['现存数量', String(totalOnHand), '不可由页面直接修改'], ['预占数量', String(totalReserved), '由订单状态机维护'], ['可售数量', String(summary.totalAvailable), '现存－预占']]
    : source === 'muku'
      ? [['快照记录', mukuInventory ? String(mukuInventory.pagination.total) : '未知', '外部 SKU × 仓库'], ['本页已知可用', mukuAvailableSummary, '未知值不按 0 计'], ['本页已知在途', mukuTransitSummary, '只读参考值'], ['本页字段未知', String(mukuUnknownRows), '保持未知，不补零']]
      : [['风险记录', mukuRisk ? String(mukuRisk.pagination.total) : '未知', '外部规则结果'], ['慢动销', String(slowMoving), '本页明确命中'], ['超龄', String(overAge), '本页明确命中'], ['活跃低库存', String(lowStock), '本页明确命中']];
  const external = source !== 'erp';
  const inventoryLoading = mukuBusy === 'inventory' && !mukuInventory;
  const riskLoading = mukuBusy === 'risk' && !mukuRisk;
  const pagination = source === 'muku' ? mukuInventory?.pagination : mukuRisk?.pagination;
  const hasMukuFilters = Boolean(mukuFilters.sku || (source === 'muku' && mukuFilters.warehouse));

  return <div className="content module-content">
    <div className="module-head">
      <div><p>可信业务闭环 / 库存</p><h1>商品库存</h1><span>{external ? 'MUKU 数据仅作为外部只读参考，与 ERP 自有库存账本严格分开' : '余额由不可变流水和订单动作驱动，页面不提供直接改数入口'}</span></div>
      <div className={external ? 'source-chip external' : 'ledger-chip'}>{external ? 'MUKU 只读快照' : '库存账本已启用'}</div>
    </div>
    {external && <MukuConnectorCard status={mukuStatus} runs={mukuRuns} busy={mukuBusy} error={mukuError} canSync={canSync} testConnection={testConnection} syncReadOnly={syncReadOnly} />}
    <StatCards stats={stats} />
    {source === 'erp' && !hasInventoryData && <DataSourceNotice compact />}
    {external && <div className="muku-readonly-notice" role="note"><strong>外部只读快照</strong><span>不参与 ERP 预占、出库或采购入库；同步不会覆盖本地库存。</span></div>}
    {external && mukuError && <div className="muku-readonly-notice warning" role="alert"><strong>本次读取失败</strong><span>{mukuError}{(mukuInventory || mukuRisk) ? '；页面继续显示上次有效快照。' : ''}</span></div>}
    <article className="card data-card">
      <div className="data-toolbar inventory-source-toolbar"><div><button className={source === 'erp' ? 'tab-active' : ''} onClick={() => setSource('erp')}>ERP 库存账本</button>{canRead && <button className={source === 'muku' ? 'tab-active' : ''} onClick={() => setSource('muku')}>MUKU 只读库存</button>}{canRead && <button className={source === 'risk' ? 'tab-active' : ''} onClick={() => setSource('risk')}>库存风险</button>}</div><span>{source === 'erp' ? '可售量 = 现存 − 预占' : '顶部搜索筛选当前页；下方条件查询整个只读快照'}</span></div>
      {external && <form className="muku-filter-bar" onSubmit={(event) => { event.preventDefault(); applyMukuFilters(filterDraft); }}><label><span>SKU 精确查询</span><input value={filterDraft.sku} onChange={(event) => setFilterDraft((current) => ({ ...current, sku: event.target.value }))} placeholder="输入 SKU，可留空" /></label>{source === 'muku' && <label><span>仓库查询</span><input value={filterDraft.warehouse} onChange={(event) => setFilterDraft((current) => ({ ...current, warehouse: event.target.value }))} placeholder="仓库编码或完整名称" /></label>}<div><button className="secondary-button" type="button" disabled={Boolean(mukuBusy) || (!mukuFilters.sku && !mukuFilters.warehouse)} onClick={() => { const empty = { sku: '', warehouse: '' }; setFilterDraft(empty); applyMukuFilters(empty); }}>清除</button><button className="primary-button" type="submit" disabled={Boolean(mukuBusy)}>查询快照</button></div></form>}
      {source === 'erp' && <><div className="table-wrap module-table"><table><thead><tr><th>SKU</th><th>商品名称</th><th>仓库</th><th>现存</th><th>预占</th><th>可售</th><th>库存状态</th><th>版本</th></tr></thead><tbody>{inventory.length ? inventory.map((item) => <tr key={item.id}><td><strong>{item.skuCode}</strong></td><td>{item.skuName}</td><td>{item.warehouseName}</td><td>{item.onHandQty}</td><td>{item.reservedQty}</td><td><strong>{item.availableQty}</strong></td><td><InventoryStatus available={item.availableQty} /></td><td>v{item.version}</td></tr>) : <tr><td className="empty-cell" colSpan={8}>{hasQuery ? '没有符合当前搜索条件的库存记录' : '尚未接入真实 SKU、仓库和库存记录'}</td></tr>}</tbody></table></div><div className="pagination"><span>订单审核、取消和发货后自动更新</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></>}
      {source === 'muku' && <><div className="table-wrap module-table muku-source-table"><table><thead><tr><th>SKU / 商品</th><th>仓库</th><th>可用</th><th>锁定</th><th>在手</th><th>在途</th><th>库龄</th><th>源更新时间</th></tr></thead><tbody>{inventoryLoading ? <tr><td className="empty-cell" colSpan={8}>正在读取 MUKU 只读库存快照…</td></tr> : mukuInventoryRows.length ? mukuInventoryRows.map((item) => <tr key={item.id}><td><strong>{formatNullableValue(item.sku)}</strong><small className="cell-sub">{item.productName ?? item.normalizedSku ?? '商品信息未知'}</small></td><td>{item.warehouseName ?? '未知'}<small className="cell-sub">{item.warehouseCode ?? '仓库编码未知'}</small></td><td><strong className={item.available === null ? 'null-value' : ''}>{formatNullableValue(item.available)}</strong></td><td className={item.locked === null ? 'null-value' : ''}>{formatNullableValue(item.locked)}</td><td className={item.onHand === null ? 'null-value' : ''}>{formatNullableValue(item.onHand)}</td><td className={item.inTransit === null ? 'null-value' : ''}>{formatNullableValue(item.inTransit)}</td><td className={item.ageDays === null ? 'null-value' : ''}>{formatNullableValue(item.ageDays, ' 天')}</td><td>{formatOptionalTime(item.sourceUpdatedAt)}<small className="cell-sub">ERP 获取：{formatOptionalTime(item.ingestedAt)}</small></td></tr>) : <tr><td className="empty-cell" colSpan={8}>{(hasQuery || hasMukuFilters) && mukuInventory ? '没有符合当前查询条件的外部库存' : '尚未取得 MUKU 库存快照；不会用模拟值填充'}</td></tr>}</tbody></table></div><MukuPaginationView pagination={pagination} currentPage={mukuPage} setPage={setMukuPage} busy={Boolean(mukuBusy)} fallbackText={mukuInventory?.stale ? '数据已过时，显示最后有效快照' : `源生成：${formatOptionalTime(mukuInventory?.generatedAt ?? null)}`} /></>}
      {source === 'risk' && <><div className="table-wrap module-table muku-source-table"><table><thead><tr><th>SKU</th><th>命中风险</th><th>可用 / 在手</th><th>30 天销量</th><th>最大库龄</th><th>源更新时间</th></tr></thead><tbody>{riskLoading ? <tr><td className="empty-cell" colSpan={6}>正在读取 MUKU 库存风险快照…</td></tr> : mukuRiskRows.length ? mukuRiskRows.map((item) => { const labels = mukuRiskLabels(item); return <tr key={item.id}><td><strong>{formatNullableValue(item.sku)}</strong><small className="cell-sub">{item.normalizedSku ?? '标准化 SKU 未知'}</small></td><td><div className="risk-tags">{labels.map((label) => <span className={label === '判定未知' ? 'risk-pill unknown' : label === '未命中已知规则' ? 'risk-pill clear' : 'risk-pill'} key={label}>{label}</span>)}</div></td><td>{formatNullableValue(item.available)} / {formatNullableValue(item.onHand)}<small className="cell-sub">锁定：{formatNullableValue(item.locked)}</small></td><td className={item.sales30d === null ? 'null-value' : ''}>{formatNullableValue(item.sales30d)}</td><td className={item.ageDays === null ? 'null-value' : ''}>{formatNullableValue(item.ageDays, ' 天')}</td><td>{formatOptionalTime(item.sourceUpdatedAt)}</td></tr>; }) : <tr><td className="empty-cell" colSpan={6}>{(hasQuery || hasMukuFilters) && mukuRisk ? '没有符合当前查询条件的风险记录' : '尚未取得 MUKU 风险快照；未知不会显示为无风险'}</td></tr>}</tbody></table></div><MukuPaginationView pagination={pagination} currentPage={mukuPage} setPage={setMukuPage} busy={Boolean(mukuBusy)} fallbackText={mukuRisk?.stale ? '数据已过时，显示最后有效快照' : `源生成：${formatOptionalTime(mukuRisk?.generatedAt ?? null)}`} /></>}
    </article>
  </div>;
}

function MukuConnectorCard({ status, runs, busy, error, canSync, testConnection, syncReadOnly }: {
  status: MukuStatus | null;
  runs: MukuRunsPayload | null;
  busy: string;
  error: string;
  canSync: boolean;
  testConnection: () => void;
  syncReadOnly: () => void;
}) {
  const state = mukuStatusPresentation(status);
  return <section className="muku-connector-grid" aria-label="MUKU 连接状态"><article className="card muku-connector-card"><div className="muku-connector-summary"><div><p>MUKU DATA COMMAND</p><h3>看板只读数据源</h3><span>ERP 后端代理读取；浏览器不会直连 MUKU，也不提供密钥输入。</span></div><span className={`connector-state ${state.className}`}>{state.label}</span></div><dl><div><dt>已配置</dt><dd>{status ? (status.configured ? '是' : '否') : '未知'}</dd></div><div><dt>API 版本</dt><dd>{status?.apiVersion ?? '未知'}</dd></div><div><dt>数据集数量</dt><dd>{status ? status.datasetCount : '未知'}</dd></div><div><dt>最近成功</dt><dd>{formatOptionalTime(status?.lastSuccessAt ?? null)}</dd></div><div><dt>源生成时间</dt><dd>{formatOptionalTime(status?.sourceGeneratedAt ?? null)}</dd></div><div><dt>ERP 同步时间</dt><dd>{formatOptionalTime(status?.syncedAt ?? null)}</dd></div><div><dt>错误代码</dt><dd className={status?.errorCode ? 'muku-error-code' : ''}>{status?.errorCode ?? '无'}</dd></div></dl><div className="muku-operations"><div><h4>数据集新鲜度</h4>{status?.datasets.length ? <ul>{status.datasets.slice(0, 4).map((dataset) => <li key={dataset.dataset}><span><strong>{mukuDatasetLabel(dataset.dataset)}</strong><small>{dataset.recordCount === null ? '记录数未知' : `${dataset.recordCount} 条`} · {formatOptionalTime(dataset.generatedAt)}</small></span><b className={`muku-run-${dataset.status}`}>{mukuRunStatusLabel(dataset.status)}</b></li>)}</ul> : <p>尚无已同步数据集；先测试连接，再执行只读同步。</p>}</div><div><h4>最近同步运行</h4>{runs?.records.length ? <ul>{runs.records.slice(0, 4).map((run) => <li key={run.id}><span><strong>{mukuDatasetLabel(run.dataset)}</strong><small>{formatOptionalTime(run.startedAt)} · {run.recordCount === null ? '记录数未知' : `${run.recordCount} 条`}{run.replayed ? ' · 幂等重放' : ''}</small></span><b className={`muku-run-${run.status}`}>{mukuRunStatusLabel(run.status)}</b></li>)}</ul> : <p>暂无同步运行记录。</p>}</div></div>{error && <p className="muku-card-error">{error}</p>}{canSync ? <div className="muku-connector-actions"><button className="secondary-button" onClick={testConnection} disabled={Boolean(busy)}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="primary-button" onClick={syncReadOnly} disabled={Boolean(busy) || !status?.configured}>{busy === 'sync' ? '同步中…' : '只读同步'}</button></div> : <p className="muku-permission-note">当前账号可查看只读快照，无连接测试或同步权限。</p>}</article></section>;
}

function MukuPaginationView({ pagination, currentPage, setPage, busy, fallbackText }: {
  pagination: MukuPagination | undefined;
  currentPage: number;
  setPage: (page: number) => void;
  busy: boolean;
  fallbackText: string;
}) {
  const page = pagination?.page ?? currentPage;
  const totalPages = pagination?.totalPages ?? Math.max(1, page);
  return <div className="pagination muku-pagination"><span>{fallbackText}</span><div><button aria-label="上一页" disabled={busy || page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>‹</button><button className="current" disabled>{page} / {totalPages}</button><button aria-label="下一页" disabled={busy || !(pagination?.hasNext ?? false)} onClick={() => setPage(page + 1)}>›</button></div></div>;
}

function PurchaseWorkspaceView({ planning, planningRows, planningError, demands, requests, purchaseOrders, purchaseReceipts, workspace, tab, setTab, selectedPlanRowIds, togglePlanningRow, openPlanningRequest, openPlanningMapping, openPlanningPolicy, openInventoryConfirmation, selectedDemandIds, toggleDemand, openMapping, openRequest, openSupplier, openWarehouse, openPurchaseOrder, openReceipt, can, busy, runAction, runOrderAction, hasQuery }: {
  planning: PurchasePlanningPayload | null; planningRows: PurchasePlanningRow[]; planningError: string;
  demands: PurchaseDemand[]; requests: PurchaseRequest[]; purchaseOrders: PurchaseOrder[]; purchaseReceipts: PurchaseReceipt[];
  workspace: PurchaseWorkspacePayload | null; tab: PurchaseTab; setTab: (tab: PurchaseTab) => void;
  selectedPlanRowIds: Set<string>; togglePlanningRow: (id: string) => void;
  openPlanningRequest: () => void; openPlanningMapping: (exception: MukuPlanningException) => void;
  openPlanningPolicy: (row: PurchasePlanningRow) => void;
  openInventoryConfirmation: (row: PurchasePlanningRow) => void;
  selectedDemandIds: Set<string>; toggleDemand: (id: string) => void;
  openMapping: (demand: PurchaseDemand) => void; openRequest: () => void; openSupplier: () => void; openWarehouse: () => void;
  openPurchaseOrder: (request: PurchaseRequest) => void; openReceipt: (order: PurchaseOrder) => void;
  can: (permission: Permission) => boolean; busy: string;
  runAction: (request: PurchaseRequest, action: PurchaseRequestAction) => void;
  runOrderAction: (order: PurchaseOrder, action: 'issue' | 'cancel') => void; hasQuery: boolean;
}) {
  const summary = workspace?.summary ?? emptyPurchaseSummary;
  const requestSummary = workspace?.requestSummary ?? emptyPurchaseRequestSummary;
  const procurementSummary = workspace?.procurementSummary ?? emptyProcurementSummary;
  const allOrders = workspace?.purchaseOrders ?? purchaseOrders;
  const activeRequestIds = new Set(allOrders.filter((order) => order.status !== 'cancelled').map((order) => order.purchaseRequestId));
  const approvedRequests = requests.filter((request) => request.status === 'approved' && !activeRequestIds.has(request.id));
  const activeOrders = purchaseOrders.filter((order) => ['draft', 'issued', 'partially_received'].includes(order.status));
  const closedOrders = purchaseOrders.filter((order) => ['received', 'cancelled'].includes(order.status));
  const historyRequests = requests.filter((request) => ['rejected', 'cancelled'].includes(request.status));
  const pendingDemandCount = (workspace?.demands ?? demands).filter(
    (demand) => demand.status === 'open' && demandAvailableQuantity(demand) > 0,
  ).length;
  const availableQuantity = summary.availableQuantity ?? demands.filter((demand) => demand.status === 'open').reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const stats = [
    ['建议采购', planning ? formatOptionalQuantity(planning.summary.recommendedQty) : '未知', '订单需求 + 安全库存 - 有效覆盖'],
    ['可转申请', planning ? String(planning.summary.convertibleOrderQty) : '未知', '仅转换已验证官方订单需求'],
    ['待复审申请', String(requestSummary.pendingReview), '审批后才能正式下单'],
    ['待到货数量', String(procurementSummary.pendingReceiptQuantity), '已下单未完成入库'],
  ];
  const visibleDemands = tab === 'pending'
    ? demands.filter((demand) => demand.status === 'open' && demandAvailableQuantity(demand) > 0)
    : tab === 'mapping' ? demands.filter((demand) => demand.status === 'needs_mapping') : [];
  const visibleRequests = requests.filter((request) => request.status === 'draft' || request.status === 'pending_review');
  const selectedDemands = (workspace?.demands ?? []).filter((demand) => selectedDemandIds.has(demand.id));
  const selectedQuantity = selectedDemands.reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const tabs: Array<[PurchaseTab, string, number]> = [
    ['planning', '今日采购建议', planning?.summary.buy ?? 0],
    ['pending', '待处理需求', pendingDemandCount],
    ['mapping', 'SKU 映射', summary.needsMapping],
    ['requests', '申请与复审', requestSummary.draft + requestSummary.pendingReview],
    ['approved', '待转采购单', approvedRequests.length],
    ['orders', '采购单 / 待到货', activeOrders.length],
    ['received', '到货记录', purchaseReceipts.length],
    ['history', '历史', historyRequests.length + closedOrders.length],
  ];
  const toolbarText = tab === 'planning'
    ? planning ? `建议 ${formatOptionalQuantity(planning.summary.recommendedQty)} 件 · 可转申请 ${planning.summary.convertibleOrderQty} 件` : '等待采购建议'
    : tab === 'pending' ? `可采购 ${availableQuantity} 件`
    : tab === 'mapping' ? '映射后自动进入待处理'
      : tab === 'orders' ? `待到货 ${procurementSummary.pendingReceiptQuantity} 件`
        : tab === 'received' ? `累计入库 ${procurementSummary.receivedQuantity} 件`
          : `供应商 ${procurementSummary.suppliers} 家`;
  return <div className="content module-content"><div className="module-head"><div><p>订单需求 / 采购执行</p><h1>采购工作台</h1><span>已验证的官方订单形成采购需求，经过申请、复审、供应商下单和到货登记后更新 ERP 库存；不会向 Shopify 写入。</span></div><div className="purchase-head-actions"><div className="ledger-chip">需求防重复 · 入库有流水 · 历史不删除</div>{can('warehouse:manage') && <button className="secondary-button warehouse-button" onClick={openWarehouse} disabled={Boolean(busy)}><span>＋</span>仓库</button>}{can('purchase:supplier:create') && <button className="primary-button" onClick={openSupplier} disabled={Boolean(busy)}><span>＋</span>供应商</button>}</div></div><StatCards stats={stats} />
    {planning && !planning.orderSourceReadiness && <div className="planning-order-source-warning purchase-source-warning"><strong>官方订单源未就绪</strong><span>{formatOrderSourceWarning(planning)}</span></div>}
    <article className="card data-card purchase-workspace-card"><div className="data-toolbar purchase-toolbar"><div>{tabs.map(([key, label, count]) => <button key={key} className={tab === key ? 'tab-active' : ''} onClick={() => setTab(key)}>{label}<b>{count}</b></button>)}</div><span>{toolbarText}</span></div>
      {tab === 'planning' ? <PurchasePlanningView planning={planning} rows={planningRows} error={planningError} skuOptions={workspace?.skuOptions ?? []} selectedPlanRowIds={selectedPlanRowIds} toggleRow={togglePlanningRow} openRequest={openPlanningRequest} openMapping={openPlanningMapping} openPolicy={openPlanningPolicy} openInventoryConfirmation={openInventoryConfirmation} canCreate={can('purchase:create')} canMap={can('purchase:mapping')} busy={busy} hasQuery={hasQuery} />
        : tab === 'pending' || tab === 'mapping' ? <>
        {tab === 'pending' && <div className="purchase-selection"><div><strong>已选 {selectedDemandIds.size} 行 / {selectedQuantity} 件</strong><span>每条需求只能进入一张有效采购申请</span></div><button className="primary-button" disabled={!selectedDemandIds.size || !can('purchase:create') || Boolean(busy) || planning?.orderSourceReadiness !== true} onClick={openRequest}><span>＋</span>生成采购申请</button></div>}
        <PurchaseDemandTable demands={visibleDemands} selectable={tab === 'pending'} selectedDemandIds={selectedDemandIds} toggleDemand={toggleDemand} openMapping={openMapping} canMap={can('purchase:mapping')} busy={busy} emptyMessage={hasQuery ? '没有符合当前搜索条件的需求' : tab === 'pending' ? '暂无可采购需求；待映射 SKU 完成后会出现在这里' : '暂无待映射的真实订单行'} />
      </> : tab === 'requests' ? <><div className="planning-inline-warning"><strong>{workspace?.developmentOpenAccess ? '开发试运行模式' : '正式岗位分离'}</strong> {workspace?.developmentOpenAccess ? '当前允许同一人兼任采购负责人和复审人，仅用于开发测试；操作仍只对被分配成员开放。' : '采购负责人负责提交，指定复审人负责批准或驳回，且两者必须为不同成员。'}</div><PurchaseRequestTable requests={visibleRequests} currentMemberId={workspace?.currentMemberId ?? null} can={can} busy={busy} runAction={runAction} emptyMessage={hasQuery ? '没有符合当前搜索条件的采购申请' : '暂无草稿或待复审申请，可从待处理需求生成'} /></>
        : tab === 'approved' ? <PurchaseRequestTable requests={approvedRequests} currentMemberId={workspace?.currentMemberId ?? null} can={can} busy={busy} runAction={runAction} openPurchaseOrder={openPurchaseOrder} emptyMessage={hasQuery ? '没有符合当前搜索条件的已批准申请' : '暂无待转采购单；采购申请批准后会出现在这里'} />
          : tab === 'orders' ? <PurchaseOrderTable orders={activeOrders} can={can} busy={busy} openReceipt={openReceipt} runAction={runOrderAction} emptyMessage={hasQuery ? '没有符合当前搜索条件的采购单' : '暂无待下单或待到货采购单'} />
            : tab === 'received' ? <PurchaseReceiptTable receipts={purchaseReceipts} emptyMessage={hasQuery ? '没有符合当前搜索条件的到货记录' : '暂无到货记录；确认采购单下单后可分批登记到货'} />
              : <div className="purchase-history-sections"><div><h3>已结束的申请</h3><PurchaseRequestTable requests={historyRequests} currentMemberId={workspace?.currentMemberId ?? null} can={can} busy={busy} runAction={runAction} emptyMessage="暂无驳回或取消的采购申请" /></div><div><h3>已结束的采购单</h3><PurchaseOrderTable orders={closedOrders} can={can} busy={busy} openReceipt={openReceipt} runAction={runOrderAction} emptyMessage="暂无完成或取消的正式采购单" /></div></div>}
      <div className="pagination"><span>取消、退款、到货和库存变化均保留原始记录；系统不物理删除采购历史</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div>
    </article>
  </div>;
}

function PurchasePlanningView({ planning, rows, error, skuOptions, selectedPlanRowIds, toggleRow, openRequest, openMapping, openPolicy, openInventoryConfirmation, canCreate, canMap, busy, hasQuery }: {
  planning: PurchasePlanningPayload | null; rows: PurchasePlanningRow[]; error: string;
  skuOptions: PurchaseSkuOption[]; selectedPlanRowIds: Set<string>; toggleRow: (id: string) => void;
  openRequest: () => void; openMapping: (exception: MukuPlanningException) => void;
  openPolicy: (row: PurchasePlanningRow) => void;
  openInventoryConfirmation: (row: PurchasePlanningRow) => void;
  canCreate: boolean; canMap: boolean;
  busy: string; hasQuery: boolean;
}) {
  const [showAllMappings, setShowAllMappings] = useState(false);
  if (!planning) {
    return <div className="planning-unavailable"><strong>采购建议暂时不可用</strong><span>{error || '正在等待库存快照和采购策略数据。现有申请、采购单与到货流程不受影响。'}</span></div>;
  }
  const freshness = planning.freshness;
  const sourceTimeBlocked = planning.rows.some((row) => row.blockers.some((reason) => [
    'inventory_source_stale', 'inventory_source_time_unknown', 'inventory_source_time_invalid',
  ].includes(reason)));
  const freshnessState = freshness.readyForProcurement && !sourceTimeBlocked
    ? { label: '库存数据可用于采购', className: 'ready' }
    : freshness.status === 'refreshing'
      ? { label: '库存正在刷新', className: 'pending' }
      : freshness.readyForProcurement
        ? { label: 'MUKU 出口已更新，仓库源数据需处理', className: 'error' }
        : { label: '库存数据不可用于采购', className: 'error' };
  const inventoryFreshness = freshness.datasets.find((item) => item.dataset === 'inventory');
  const operations = planning.operations;
  const selectedRows = planning.rows.filter((row) => selectedPlanRowIds.has(row.planRowId));
  const selectedQuantity = selectedRows.reduce((sum, row) => sum + row.conversion.eligibleOrderQty, 0);
  const mappingExceptions = planning.mappingExceptions.muku;
  return <div className="planning-workspace">
    <section className={`planning-freshness ${freshnessState.className}`} aria-label="采购数据新鲜度">
      <div><span className="planning-signal" /><div><strong>{freshnessState.label}</strong><small>最近检查 {formatOptionalTime(freshness.checkedAt)} · 允许时效 {freshness.maxAgeMinutes} 分钟</small></div></div>
      <div className="planning-source-times"><span>MUKU 库存生成 <b>{formatOptionalTime(inventoryFreshness?.generatedAt ?? null)}</b></span><span>ERP 同步 <b>{formatOptionalTime(inventoryFreshness?.lastSuccessAt ?? null)}</b></span></div>
      {!freshness.readyForProcurement && <p>{freshness.blockingReasons.map((reason) => reason.message).join('；') || '库存快照状态未知，暂不允许转采购申请。'}</p>}
      {freshness.readyForProcurement && sourceTimeBlocked && <p>ERP 刚读取到 MUKU 导出，但至少一项仓库业务源时间未知、无效或超过采购时效，相关建议已被阻断。</p>}
    </section>
    <section className="planning-operations" aria-label="采购数据自动化运维状态">
      <div className="planning-operations-head">
        <div><strong>持续同步与到期监控</strong><small>{operations.browserRefresh.note}</small></div>
        <span className={`status-pill ${operations.automationReady ? 'success' : 'danger'}`}>{operations.automationReady ? '安全调度已确认' : '自动化尚未闭环'}</span>
      </div>
      <div className="planning-operations-grid">
        <article className={operations.muku.dataReady ? 'ready' : 'blocked'}>
          <div className="planning-operation-title"><div><strong>MUKU 库存</strong><small>建议每 {operations.muku.recommendedIntervalMinutes} 分钟检查一次到期状态</small></div><span className={`status-pill ${operations.muku.automationReady ? 'success' : ''}`}>{operations.muku.automationReady ? '已调度' : operations.muku.endpointReady ? '仅任务入口' : '入口未就绪'}</span></div>
          <div className="planning-operation-times"><span>最近成功<b>{formatOptionalTime(operations.muku.lastSuccessAt)}</b></span><span>数据有效至<b>{formatOptionalTime(operations.muku.freshUntil)}</b></span><span>建议刷新点<b>{formatOptionalTime(operations.muku.nextRefreshDueAt)}</b></span></div>
          <small className="planning-operation-config">受保护入口：{operations.muku.endpointReady ? '已就绪' : '未就绪'} · 外部调度：{operations.muku.externalScheduleConfigured ? '已声明配置' : '未确认'}</small>
          {[...operations.muku.configurationBlockers, ...operations.muku.dataBlockers].length > 0 && <p>{[...operations.muku.configurationBlockers, ...operations.muku.dataBlockers].join('；')}</p>}
        </article>
        <article className={operations.shopify.stores.length > 0 && operations.shopify.stores.every((store) => store.ready) ? 'ready' : 'blocked'}>
          <div className="planning-operation-title"><div><strong>Shopify 订单</strong><small>增量补漏建议每 {operations.shopify.recommendedIntervalMinutes} 分钟运行，允许时效 {operations.shopify.maxAgeMinutes} 分钟</small></div><span className={`status-pill ${operations.shopify.automationReady ? 'success' : ''}`}>{operations.shopify.automationReady ? '已调度' : operations.shopify.endpointReady ? '仅任务入口' : '入口未就绪'}</span></div>
          <div className="planning-operation-times"><span>最近成功<b>{formatOptionalTime(operations.shopify.lastSuccessAt)}</b></span><span>最早到期<b>{formatOptionalTime(operations.shopify.nextExpiryAt)}</b></span><span>官方店铺<b>{operations.shopify.stores.length || '无'}</b></span></div>
          <small className="planning-operation-config">受保护入口：{operations.shopify.endpointReady ? '已就绪' : '未就绪'} · 外部调度：{operations.shopify.externalScheduleConfigured ? '已声明配置' : '未确认'}</small>
          {operations.shopify.stores.length > 0 && <div className="planning-store-syncs">{operations.shopify.stores.map((store) => <span key={store.storeId}><b>{store.storeName}</b>{formatOptionalTime(store.lastSuccessAt)} → {formatOptionalTime(store.freshUntil)}{store.reasons.length ? ` · ${store.reasons.map(planningReasonLabel).join('、')}` : ' · 正常'}</span>)}</div>}
          {operations.shopify.configurationBlockers.length > 0 && <p>{operations.shopify.configurationBlockers.join('；')}</p>}
        </article>
      </div>
    </section>
    <section className="planning-formula" aria-label="采购建议公式"><div><strong>系统怎么算</strong><span>{planning.formula.target} − {planning.formula.coverage}</span></div><small>{planning.formula.recommendation}。MUKU 在途只展示，不参与抵扣。</small></section>
    {error && <div className="planning-inline-warning">{error}</div>}
    <div className="purchase-selection planning-selection"><div><strong>已选 {selectedRows.length} 个 SKU / 可转 {selectedQuantity} 件</strong><span>只会把已验证的官方订单缺口转成申请；安全库存和取整超量不会伪造订单需求</span></div><button className="primary-button" disabled={!selectedRows.length || !selectedQuantity || !canCreate || Boolean(busy) || planning.readiness === 'stale' || !planning.orderSourceReadiness} onClick={openRequest}><span>＋</span>按建议生成申请</button></div>
    <PurchasePlanningTable planning={planning} rows={rows} selectedPlanRowIds={selectedPlanRowIds} toggleRow={toggleRow} openPolicy={openPolicy} openInventoryConfirmation={openInventoryConfirmation} canMap={canMap} busy={busy} hasQuery={hasQuery} />
    {mappingExceptions.length > 0 && <section className="planning-exceptions"><div className="planning-section-head"><div><strong>MUKU SKU 待映射</strong><span>{mappingExceptions.length} 项库存尚未归属到 ERP SKU，不会按 0 库存参与建议</span></div>{mappingExceptions.length > 24 && <button onClick={() => setShowAllMappings((current) => !current)}>{showAllMappings ? '收起' : `展开全部 ${mappingExceptions.length} 项`}</button>}</div><div className="planning-exception-grid">{(showAllMappings ? mappingExceptions : mappingExceptions.slice(0, 24)).map((item) => <article key={item.mukuSku}><div><strong>{item.mukuSku}</strong><small>可用 {formatOptionalQuantity(item.availableQty)} · 在途 {formatOptionalQuantity(item.inboundQty)}</small></div><span className={`status-pill ${item.status === 'ambiguous' ? 'danger' : ''}`}>{item.status === 'ambiguous' ? '存在歧义' : '未映射'}</span>{canMap && <button disabled={Boolean(busy) || !skuOptions.length} onClick={() => openMapping(item)}>去映射</button>}</article>)}</div></section>}
  </div>;
}

function PurchasePlanningTable({ planning, rows, selectedPlanRowIds, toggleRow, openPolicy, openInventoryConfirmation, canMap, busy, hasQuery }: {
  planning: PurchasePlanningPayload; rows: PurchasePlanningRow[]; selectedPlanRowIds: Set<string>;
  toggleRow: (id: string) => void; openPolicy: (row: PurchasePlanningRow) => void;
  openInventoryConfirmation: (row: PurchasePlanningRow) => void;
  canMap: boolean; busy: string; hasQuery: boolean;
}) {
  return <div className="table-wrap module-table"><table className="purchase-planning-table"><thead><tr><th className="selection-cell">选择</th><th>ERP SKU / MUKU SKU</th><th>订单需求 / 安全库存</th><th>有效可用 / 在途</th><th>ERP 覆盖 / 已收展示</th><th>建议采购</th><th>状态与依据</th><th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row) => {
    const convertible = planningRowConvertible(row, planning.readiness, planning.orderSourceReadiness);
    const matchedSkus = row.mukuSkus.map((source) => source.sku).join('、');
    const canConfirmInventory = manualInventoryConfirmationEligible(row);
    return <tr key={row.planRowId} className={row.decision === 'blocked' ? 'planning-row-blocked' : ''}><td className="selection-cell"><input className="purchase-check" type="checkbox" aria-label={`选择 ${row.skuCode}`} checked={selectedPlanRowIds.has(row.planRowId)} disabled={!convertible || Boolean(busy)} onChange={() => toggleRow(row.planRowId)} /></td><td><strong>{row.skuCode}</strong><small className="cell-sub">{row.skuName}</small><small className="cell-sub planning-match">{matchedSkus || (row.mukuMatchStatus === 'ambiguous' ? 'MUKU SKU 存在歧义' : '尚未匹配 MUKU 编码')}</small></td><td><strong>{row.orderDemandQty} / {formatOptionalQuantity(row.safetyStockQty)}</strong><small className="cell-sub">近 30 天销量：{formatOptionalQuantity(row.sales30d)}</small></td><td><strong>{formatOptionalQuantity(row.effectiveAvailableQty)} / {formatOptionalQuantity(row.mukuInboundQty)}</strong><small className="cell-sub">{planningAvailableSourceLabel(row)}</small><small className="cell-sub">在途仅展示，不抵扣</small></td><td><strong>{row.erpPurchaseChainCoverageQty}</strong><small className="cell-sub">PO 未收 {row.erpOpenPoQty} · 已收 {row.erpReceivedQty}（仅展示）</small></td><td><strong className="planning-recommendation">{formatOptionalQuantity(row.recommendedQty)}</strong><small className="cell-sub">可转官方订单 {row.conversion.eligibleOrderQty} 件</small>{row.conversion.blockedRecommendationQty > 0 && <small className="cell-sub attention-text">另有 {row.conversion.blockedRecommendationQty} 件不可自动转</small>}</td><td><span className={`status-pill planning-status-${row.decision}`}>{planningDecisionLabel(row.decision)}</span><details className="planning-explanation"><summary>查看计算依据</summary><div><p><b>公式：</b>{formatPlanningEquation(row)}</p>{row.explanations.map((text, index) => <p key={`${row.planRowId}-explanation-${index}`}>{text}</p>)}{[...row.blockers, ...row.warnings].map((reason) => <p className="attention-text" key={`${row.planRowId}-${reason}`}>{planningReasonLabel(reason)}</p>)}<p className="planning-source-note">原始 MUKU 可用量：{formatOptionalQuantity(row.mukuAvailableQty)} · 有效可用量来源：{planningAvailableSourceLabel(row)} · 库存源更新时间：{formatOptionalTime(row.sourceTimes.inventoryRecordUpdatedAt)}</p></div></details></td><td><div className="row-actions planning-row-actions">{canMap && <button disabled={Boolean(busy)} onClick={() => openPolicy(row)}>采购策略</button>}{canMap && canConfirmInventory && <button className="action-primary" disabled={Boolean(busy)} onClick={() => openInventoryConfirmation(row)}>{row.inventoryConfirmation ? '更新 / 续期库存' : '人工确认库存'}</button>}{convertible ? <span className="terminal-label">勾选后批量转申请</span> : <span className="terminal-label">{!planning.orderSourceReadiness ? '官方订单源未就绪' : row.conversion.eligibleOrderQty <= 0 && row.blockers.length === 0 ? '暂无可转订单缺口' : planningPrimaryBlocker(row)}</span>}</div></td></tr>;
  }) : <tr><td className="empty-cell" colSpan={8}>{hasQuery ? '没有符合当前搜索条件的采购建议' : '暂无可计算的 ERP SKU；接入真实订单或设置采购策略后会出现在这里'}</td></tr>}</tbody></table></div>;
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

function PurchaseRequestTable({ requests, currentMemberId, can, busy, runAction, openPurchaseOrder, emptyMessage }: {
  requests: PurchaseRequest[]; currentMemberId: string | null;
  can: (permission: Permission) => boolean; busy: string;
  runAction: (request: PurchaseRequest, action: PurchaseRequestAction) => void; emptyMessage: string;
  openPurchaseOrder?: (request: PurchaseRequest) => void;
}) {
  return <div className="table-wrap module-table"><table className="purchase-request-table"><thead><tr><th>申请单</th><th>采购负责人</th><th>复审人</th><th>明细 / 件数</th><th>状态</th><th>备注</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{requests.length ? requests.map((request) => {
    const purchaserMemberId = request.buyer?.id ?? request.purchaser?.id ?? request.purchaserMemberId;
    const assignedPurchaser = Boolean(currentMemberId && purchaserMemberId === currentMemberId);
    return <tr key={request.id}><td><strong>{request.requestNo}</strong><small className="cell-sub">创建：{request.creator?.displayName ?? '系统成员'}</small></td><td>{request.buyer?.displayName ?? '待指定'}</td><td>{request.reviewer?.displayName ?? '待指定'}</td><td>{request.lineCount} 行 / {request.totalQuantity} 件</td><td><span className={`status-pill purchase-status-${request.status}`}>{purchaseRequestStatusLabel[request.status]}</span>{request.needsAttention && <small className="cell-sub attention-text">源订单已变化，需复核</small>}</td><td>{request.reviewNote ?? request.note ?? '—'}</td><td>{formatTime(request.updatedAt)}</td><td><div className="row-actions">{request.status === 'draft' && can('purchase:submit') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction(request, 'submit')}>{busy === `${request.id}:submit` ? '提交中…' : '提交复审'}</button>}{request.status === 'draft' && can('purchase:submit') && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(request, 'cancel')}>取消</button>}{request.status === 'pending_review' && can('purchase:review') && <><button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction(request, 'approve')}>{busy === `${request.id}:approve` ? '复审中…' : '批准'}</button><button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(request, 'reject')}>驳回</button></>}{request.status === 'approved' && openPurchaseOrder && can('purchase:order:create') && !request.needsAttention && <button className="action-primary" disabled={Boolean(busy)} onClick={() => openPurchaseOrder(request)}>生成正式采购单</button>}{request.status === 'approved' && openPurchaseOrder && can('purchase:submit') && assignedPurchaser && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(request, 'withdraw')}>{busy === `${request.id}:withdraw` ? '撤回中…' : '撤回重算'}</button>}{request.status === 'approved' && request.needsAttention && <span className="terminal-label">源订单变化，暂不能转单</span>}{(['rejected','cancelled'].includes(request.status) || (request.status === 'approved' && !openPurchaseOrder)) && <span className="terminal-label">历史已保留</span>}</div></td></tr>;
  }) : <tr><td className="empty-cell" colSpan={8}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function PurchaseOrderTable({ orders, can, busy, openReceipt, runAction, emptyMessage }: {
  orders: PurchaseOrder[]; can: (permission: Permission) => boolean; busy: string;
  openReceipt: (order: PurchaseOrder) => void;
  runAction: (order: PurchaseOrder, action: 'issue' | 'cancel') => void; emptyMessage: string;
}) {
  return <div className="table-wrap module-table"><table className="purchase-order-table"><thead><tr><th>正式采购单</th><th>供应商</th><th>申请单</th><th>采购 / 已到 / 未到</th><th>金额信息</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{orders.length ? orders.map((order) => {
    const remaining = Math.max(0, order.orderedQuantity - order.receivedQuantity);
    const totalMinor = order.lines.reduce<number | null>((sum, line) => {
      if (sum === null || line.unitCostMinor === null || !order.currency || line.currency !== order.currency) return null;
      const lineAmount = line.unitCostMinor * line.orderedQuantity;
      const nextTotal = sum + lineAmount;
      return Number.isSafeInteger(lineAmount) && Number.isSafeInteger(nextTotal) ? nextTotal : null;
    }, order.lines.length ? 0 : null);
    const documentUrl = `/api/purchase/orders/${encodeURIComponent(order.id)}/document`;
    return <tr key={order.id}><td><strong>{order.orderNo}</strong><small className="cell-sub">{order.lineCount} 行 · v{order.version}</small></td><td><strong>{order.supplier.name}</strong><small className="cell-sub">{order.supplier.code}</small></td><td>{order.purchaseRequestNo}</td><td><strong>{order.orderedQuantity} / {order.receivedQuantity} / {remaining}</strong><small className="cell-sub">采购 / 已到 / 未到</small></td><td>{totalMinor !== null && order.currency ? formatMoney(totalMinor, order.currency) : '单价待补齐'}<small className="cell-sub">{order.currency ?? '币种未指定'}</small></td><td><span className={`status-pill purchase-order-status-${order.status}`}>{purchaseOrderStatusLabel[order.status]}</span></td><td>{formatTime(order.updatedAt)}</td><td><div className="row-actions">{can('purchase:read') && <><a href={documentUrl} target="_blank" rel="noreferrer">打印采购单</a><a href={`${documentUrl}?format=csv`} download>导出 CSV</a></>}{order.status === 'draft' && can('purchase:order:issue') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction(order, 'issue')}>{busy === `${order.id}:issue` ? '处理中…' : '确认下单'}</button>}{order.status === 'draft' && can('purchase:order:issue') && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction(order, 'cancel')}>取消采购单</button>}{['issued','partially_received'].includes(order.status) && can('inventory:receive') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => openReceipt(order)}>登记到货</button>}{['received','cancelled'].includes(order.status) && <span className="terminal-label">历史已保留</span>}</div></td></tr>;
  }) : <tr><td className="empty-cell" colSpan={8}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function PurchaseReceiptTable({ receipts, emptyMessage }: { receipts: PurchaseReceipt[]; emptyMessage: string }) {
  return <div className="table-wrap module-table"><table className="purchase-receipt-table"><thead><tr><th>到货单</th><th>采购单</th><th>入库仓</th><th>明细 / 件数</th><th>SKU</th><th>到货时间</th><th>状态</th></tr></thead><tbody>{receipts.length ? receipts.map((receipt) => <tr key={receipt.id}><td><strong>{receipt.receiptNo}</strong><small className="cell-sub">{receipt.note ?? '不可变入库记录'}</small></td><td>{receipt.purchaseOrderNo}</td><td><strong>{receipt.warehouse.name}</strong><small className="cell-sub">{receipt.warehouse.code}</small></td><td>{receipt.lineCount} 行 / {receipt.totalQuantity} 件</td><td>{receipt.lines.slice(0, 2).map((line) => line.skuCode).join('、')}{receipt.lines.length > 2 ? ` 等 ${receipt.lines.length} 项` : ''}</td><td>{formatTime(receipt.receivedAt)}</td><td><span className="status-pill success">已入库</span></td></tr>) : <tr><td className="empty-cell" colSpan={7}>{emptyMessage}</td></tr>}</tbody></table></div>;
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

function MukuPlanningMappingModal({ exception, skuOptions, busy, error, onClose, onSubmit }: {
  exception: MukuPlanningException; skuOptions: PurchaseSkuOption[]; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const suggestedSku = exception.candidateSkuIds.find((id) => skuOptions.some((sku) => sku.id === id));
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>归属 MUKU 库存 SKU</h2><p>确认后该库存才会参与对应 ERP SKU 的采购建议</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="mapping-context"><strong>{exception.mukuSku}</strong><span>可用 {formatOptionalQuantity(exception.availableQty)} · 在途 {formatOptionalQuantity(exception.inboundQty)}</span><code>{exception.status === 'ambiguous' ? '存在多个可能的 ERP SKU，请人工确认' : '当前尚未匹配 ERP SKU'}</code></div><div className="form-grid"><label className="full">选择 ERP SKU<select name="skuId" required defaultValue={suggestedSku ?? skuOptions[0]?.id ?? ''}><option value="" disabled>请选择 ERP SKU</option>{skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.name}</option>)}</select></label>{!skuOptions.length && <div className="form-error full">当前没有可用 ERP SKU，请先建立真实 SKU 主数据。</div>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>映射规则</span>保留 MUKU 原始 SKU · 人工映射可追溯 · 不会修改 MUKU 或共享盘</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy || !skuOptions.length}>{busy ? '正在保存…' : '确认映射并重算'}</button></div></form></div>;
}

function PlanningPolicyModal({ row, suppliers, busy, error, onClose, onSubmit }: {
  row: PurchasePlanningRow; suppliers: PurchaseSupplier[]; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const activeSuppliers = suppliers.filter((supplier) => supplier.active);
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-modal planning-policy-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>采购策略</h2><p>{row.skuCode} · {row.skuName}</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="form-grid"><label>安全库存天数<input name="safetyDays" type="number" min="0" max="365" step="1" defaultValue={row.safetyDays} required /></label><label>固定安全库存<input name="safetyStockQty" type="number" min="0" step="1" defaultValue={row.safetyStockBasis === 'explicit' ? row.safetyStockQty ?? '' : ''} placeholder="留空按近 30 天销量" /></label><label>最小采购量 MOQ<input name="moq" type="number" min="1" step="1" defaultValue={row.policy.moq ?? ''} placeholder="留空不限制" /></label><label>包装倍数<input name="packSize" type="number" min="1" step="1" defaultValue={row.policy.packSize ?? ''} placeholder="留空不取整" /></label><label>采购提前期（天）<input name="leadTimeDays" type="number" min="0" step="1" defaultValue={row.policy.leadTimeDays ?? ''} placeholder="可选" /></label><label>首选供应商<select name="preferredSupplierId" defaultValue={row.policy.preferredSupplierId ?? ''}><option value="">暂不指定</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>计算规则</span>留空固定安全库存时按近 30 天销量估算；销量未知会明确显示“未知”，不会补成 0</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存并重新计算'}</button></div></form></div>;
}

function InventoryConfirmationModal({ row, busy, error, onClose, onSubmit }: {
  row: PurchasePlanningRow; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const previous = row.inventoryConfirmation;
  const mappingText = row.mukuMatchStatus === 'unmapped'
    ? '当前未匹配到 MUKU 编码，但不存在歧义'
    : `已通过${row.mukuMatchStatus === 'manual' ? '人工' : '精确'}规则匹配 MUKU SKU`;
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-modal inventory-confirmation-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>{previous ? '更新并续期库存确认' : '人工确认仓库可用库存'}</h2><p>{row.skuCode} · {row.skuName}</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="mapping-context"><strong>MUKU 可用库存：未知</strong><span>{mappingText}</span><code>确认范围：全部仓库汇总 · 保存后有效 24 小时</code></div>{previous && <div className="planning-modal-warning">上次确认 {previous.confirmedAvailableQty} 件，有效至 {formatOptionalTime(previous.expiresAt)}；本次保存会以当前时间重新计算 24 小时有效期。</div>}<div className="form-grid"><label>仓库可用库存<input name="confirmedAvailableQty" type="number" min="0" max="100000000" step="1" inputMode="numeric" defaultValue={previous?.confirmedAvailableQty ?? 0} required /></label><label>有效期<input value="保存后 24 小时" readOnly /></label><label className="full">核对说明<textarea name="note" rows={3} minLength={3} maxLength={500} defaultValue={previous?.note ?? ''} placeholder="例如：仓库人工核对，全部仓库可用库存为 0" required /></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>兜底规则</span>仅在 MUKU 可用量未知且 SKU 映射无歧义时生效；MUKU 一旦提供明确值，系统立即优先使用 MUKU。此操作不回写 MUKU 或共享盘。</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : previous ? '更新并续期 24 小时' : '确认并启用 24 小时'}</button></div></form></div>;
}

function PlanningRequestModal({ rows, members, developmentOpenAccess, busy, error, onClose, onSubmit }: {
  rows: PurchasePlanningRow[]; members: PurchaseMember[]; developmentOpenAccess: boolean;
  busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const totalQuantity = rows.reduce((sum, row) => sum + row.conversion.eligibleOrderQty, 0);
  const blockedQuantity = rows.reduce((sum, row) => sum + row.conversion.blockedRecommendationQty, 0);
  const defaultBuyer = members[0]?.id ?? '';
  const defaultReviewer = members[1]?.id ?? defaultBuyer;
  const [buyerId, setBuyerId] = useState(defaultBuyer);
  const [reviewerId, setReviewerId] = useState(defaultReviewer);
  const sameAssignee = Boolean(buyerId && buyerId === reviewerId);
  const separationBlocked = !developmentOpenAccess && sameAssignee;
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-request-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>按采购建议生成申请</h2><p>已选 {rows.length} 个 SKU，可安全关联官方订单 {totalQuantity} 件</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="purchase-selected-list">{rows.slice(0, 8).map((row) => <div key={row.planRowId}><strong>{row.skuCode}</strong><span>{row.skuName}</span><b>{row.conversion.eligibleOrderQty} 件</b></div>)}{rows.length > 8 && <small>另有 {rows.length - 8} 个 SKU 已选</small>}</div>{blockedQuantity > 0 && <div className="planning-modal-warning">另有 {blockedQuantity} 件来自安全库存或策略取整，没有对应官方订单需求，本次不会自动转申请。</div>}<div className="form-grid"><label>采购负责人<select name="purchaserMemberId" value={buyerId} onChange={(event) => setBuyerId(event.target.value)} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label>复审人<select name="reviewerMemberId" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label className="full">采购备注<textarea name="note" rows={3} maxLength={500} placeholder="可填写交期、供应商沟通或特殊要求" /></label>{separationBlocked && <div className="form-error full">正式模式要求采购负责人和复审人为不同成员。</div>}{!members.length && <div className="form-error full">当前没有可分配成员，请先让业务人员登录一次 ERP。</div>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>{developmentOpenAccess ? '开发试运行' : '岗位分离'}</span>{developmentOpenAccess ? '当前允许同一人兼任负责人和复审人，仅限开发测试；每个动作仍只允许指定成员执行。' : '负责人提交、指定复审人审批，且两人必须不同。'} 提交和审批都会重新校验最新订单、库存及确认有效期。</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" value="draft" disabled={busy || !members.length || !totalQuantity || separationBlocked}>{busy ? '处理中…' : '保存草稿'}</button><button className="primary-button" type="submit" value="submit" disabled={busy || !members.length || !totalQuantity || separationBlocked}>{busy ? '处理中…' : '创建并提交复审'}</button></div></form></div>;
}

function SkuMappingModal({ demand, skuOptions, busy, error, onClose, onSubmit }: {
  demand: PurchaseDemand; skuOptions: PurchaseSkuOption[]; busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(skuOptions.length ? 'existing' : 'new');
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>映射 ERP SKU</h2><p>同店铺、同平台 SKU 的需求会一起更新</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="mapping-context"><strong>{demand.storeName} · {demand.sourceOrderName ?? demand.sourceOrderId}</strong><span>{demand.title ?? demand.name ?? '未提供商品名'}</span><code>{demand.rawSku?.trim() || '平台未提供 SKU'}</code></div><div className="form-grid"><label className="full mapping-choice"><span><input type="radio" name="mappingMode" value="existing" checked={mode === 'existing'} disabled={!skuOptions.length} onChange={() => setMode('existing')} /> 选择已有 ERP SKU</span>{mode === 'existing' && <select name="skuId" required>{skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.name}</option>)}</select>}</label><label className="full mapping-choice"><span><input type="radio" name="mappingMode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} /> 新建并映射</span></label>{mode === 'new' && <><label>ERP SKU 编码<input name="newSkuCode" required placeholder={demand.normalizedSku ?? demand.rawSku ?? '例如 BF-001'} /></label><label>ERP SKU 名称<input name="newSkuName" required placeholder={demand.title ?? demand.name ?? '请输入商品名称'} /></label></>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>映射规则</span>保留平台原始 SKU · 映射可追溯 · 不会修改 Shopify 商品</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy || !demand.rawSku?.trim()}>{busy ? '正在保存…' : '保存映射'}</button></div></form></div>;
}

function PurchaseRequestModal({ demands, members, developmentOpenAccess, busy, error, onClose, onSubmit }: {
  demands: PurchaseDemand[]; members: PurchaseMember[]; developmentOpenAccess: boolean;
  busy: boolean; error: string;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const totalQuantity = demands.reduce((sum, demand) => sum + demandAvailableQuantity(demand), 0);
  const defaultBuyer = members[0]?.id ?? '';
  const defaultReviewer = members[1]?.id ?? defaultBuyer;
  const [buyerId, setBuyerId] = useState(defaultBuyer);
  const [reviewerId, setReviewerId] = useState(defaultReviewer);
  const sameAssignee = Boolean(buyerId && buyerId === reviewerId);
  const separationBlocked = !developmentOpenAccess && sameAssignee;
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal purchase-request-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>生成采购申请</h2><p>已选 {demands.length} 行，共 {totalQuantity} 件</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="purchase-selected-list">{demands.slice(0, 5).map((demand) => <div key={demand.id}><strong>{demand.mappedSkuCode ?? demand.rawSku ?? '未识别 SKU'}</strong><span>{demand.title ?? demand.name ?? demand.sourceOrderLineId}</span><b>{demandAvailableQuantity(demand)} 件</b></div>)}{demands.length > 5 && <small>另有 {demands.length - 5} 行已选需求</small>}</div><div className="form-grid"><label>采购负责人<select name="purchaserMemberId" value={buyerId} onChange={(event) => setBuyerId(event.target.value)} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label>复审人<select name="reviewerMemberId" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} required>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label className="full">采购备注<textarea name="note" rows={3} maxLength={500} placeholder="可填写交期、供应商沟通或特殊要求" /></label>{separationBlocked && <div className="form-error full">正式模式要求采购负责人和复审人为不同成员。</div>}{!members.length && <div className="form-error full">当前没有可分配成员，请先让业务人员登录一次 ERP。</div>}{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>{developmentOpenAccess ? '开发试运行' : '岗位分离'}</span>{developmentOpenAccess ? '当前允许同一人兼任负责人和复审人，仅限开发测试；每个动作仍只允许指定成员执行。' : '负责人提交、指定复审人审批，且两人必须不同。'} 重复需求不会生成第二张有效申请。</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" value="draft" disabled={busy || !members.length || separationBlocked}>{busy ? '处理中…' : '保存草稿'}</button><button className="primary-button" type="submit" value="submit" disabled={busy || !members.length || separationBlocked}>{busy ? '处理中…' : '创建并提交复审'}</button></div></form></div>;
}

function SupplierModal({ busy, error, onClose, onSubmit }: {
  busy: boolean; error: string; onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <div className="modal-backdrop modal-layer-top" onMouseDown={onClose}><form className="modal purchase-modal supplier-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>新增供应商</h2><p>供应商会用于正式采购单，历史采购单保留名称快照</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="form-grid"><label>供应商编码<input name="code" required minLength={1} maxLength={40} placeholder="例如 SUP-001" autoComplete="off" /></label><label>供应商名称<input name="name" required minLength={1} maxLength={120} placeholder="请输入公司或工厂名称" autoComplete="off" /></label><label className="full">备注<textarea name="note" rows={3} maxLength={500} placeholder="可填写主营品类或内部说明；不要填写账号密码" /></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>主数据规则</span>编码在当前 ERP 内唯一 · 不物理删除 · 所有新增操作自动审计</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存供应商'}</button></div></form></div>;
}

function WarehouseModal({ busy, error, onClose, onSubmit }: {
  busy: boolean; error: string; onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <div className="modal-backdrop modal-layer-top" onMouseDown={onClose}><form className="modal purchase-modal warehouse-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>新增 ERP 仓库</h2><p>到货登记必须选择真实入库仓，库存会按 SKU × 仓库分别累计</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="form-grid"><label>仓库编码<input name="code" required minLength={1} maxLength={40} placeholder="例如 SZ-01" autoComplete="off" /></label><label>仓库名称<input name="name" required minLength={1} maxLength={120} placeholder="例如 深圳成品仓" autoComplete="off" /></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>库存规则</span>仓库编码在当前 ERP 内唯一 · 新增不会改变现有库存 · 入库后才产生库存流水</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存仓库'}</button></div></form></div>;
}

function PurchaseOrderModal({ request, suppliers, busy, error, openSupplier, onClose, onSubmit }: {
  request: PurchaseRequest; suppliers: PurchaseSupplier[]; busy: boolean; error: string;
  openSupplier: () => void; onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const activeSuppliers = suppliers.filter((supplier) => supplier.active);
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal procurement-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>生成正式采购单</h2><p>{request.requestNo} · {request.lineCount} 行 / {request.totalQuantity} 件</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="form-grid"><label className="full">供应商<div className="select-with-action"><select name="supplierId" required defaultValue={activeSuppliers[0]?.id ?? ''}><option value="" disabled>请选择供应商</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select><button type="button" onClick={openSupplier} disabled={busy}>＋ 新增</button></div></label><label>采购币种<select name="currency" defaultValue="CNY"><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option><option value="EUR">EUR 欧元</option><option value="GBP">GBP 英镑</option></select></label><label>当前状态<input value="草稿（确认下单前不入库）" readOnly /></label><label className="full">采购备注<textarea name="note" rows={2} maxLength={500} placeholder="可填写议价、交期或包装要求" /></label></div><div className="purchase-order-lines"><div className="purchase-order-lines-head"><strong>采购明细</strong><span>单价可暂不填写，金额按所选币种保存</span></div>{request.lines.map((line) => <div className="purchase-order-line" key={line.id}><div><strong>{line.skuCode ?? line.rawSku ?? '未识别 SKU'}</strong><span>{line.skuName ?? '采购申请明细'}</span></div><b>{line.requestedQuantity} 件</b><label>采购单价<input name={`unitCost:${line.id}`} type="number" min="0" step="0.01" placeholder="可选" inputMode="decimal" /></label></div>)}</div>{!activeSuppliers.length && <div className="form-error">请先新增一个可用供应商，再生成正式采购单。</div>}{error && <div className="form-error">{error}</div>}<div className="modal-safety"><span>生成规则</span>一张已批准申请只能生成一张有效采购单 · 取消后历史仍保留 · 不会向 Shopify 写入</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy || !activeSuppliers.length}>{busy ? '正在生成…' : '生成采购单草稿'}</button></div></form></div>;
}

function PurchaseReceiptModal({ order, warehouses, busy, error, canCreateWarehouse, openWarehouse, onClose, onSubmit }: {
  order: PurchaseOrder; warehouses: PurchaseWarehouse[]; busy: boolean; error: string;
  canCreateWarehouse: boolean; openWarehouse: () => void;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const receivableLines = order.lines.filter((line) => line.remainingQuantity > 0);
  const now = new Date();
  const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal procurement-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>登记采购到货</h2><p>{order.orderNo} · {order.supplier.name}</p></div><button type="button" onClick={onClose} disabled={busy}>×</button></div><div className="form-grid"><label>本次入库仓<div className="select-with-action"><select name="warehouseId" required defaultValue={warehouses[0]?.id ?? ''}><option value="" disabled>请选择仓库</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}</select>{canCreateWarehouse && <button type="button" onClick={openWarehouse} disabled={busy}>＋ 新增</button>}</div></label><label>实际到货时间<input name="receivedAt" type="datetime-local" defaultValue={localDateTime} required /></label><label className="full">到货备注<textarea name="note" rows={2} maxLength={500} placeholder="可填写送货单号、批次或异常说明" /></label></div><div className="purchase-order-lines"><div className="purchase-order-lines-head"><strong>本次实际到货</strong><span>可以分批登记，累计数量不能超过采购数量</span></div>{receivableLines.map((line) => <div className="purchase-order-line receipt-line" key={line.id}><div><strong>{line.skuCode}</strong><span>{line.skuName}</span></div><b>已到 {line.receivedQuantity} / 未到 {line.remainingQuantity}</b><label>本次到货<input name={`quantity:${line.id}`} type="number" min="0" max={line.remainingQuantity} step="1" defaultValue={line.remainingQuantity} inputMode="numeric" /></label></div>)}</div>{!warehouses.length && <div className="form-error missing-master-data"><span>当前没有可用仓库，无法登记入库。</span>{canCreateWarehouse && <button type="button" onClick={openWarehouse}>立即新增仓库</button>}</div>}{error && <div className="form-error">{error}</div>}<div className="modal-safety"><span>库存规则</span>提交后自动增加 ERP 现存库存并写入不可变入库流水 · 重复提交不会重复加库存</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy || !warehouses.length || !receivableLines.length}>{busy ? '正在入库…' : '确认本次到货并入库'}</button></div></form></div>;
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

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readApiMessage(value: unknown, fallback: string) {
  const root = asObject(value);
  const error = asObject(root.error);
  const failedRun = readArray(root.results).map(asObject).find((result) => readString(result.status) === 'failed');
  return readString(root.message, error.message, root.errorCode, error.code, failedRun?.errorCode) ?? fallback;
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => readString(item)).filter((item): item is string => item !== null);
  const single = readString(value);
  return single ? [single] : [];
}

function readArray(...values: unknown[]): unknown[] {
  for (const value of values) if (Array.isArray(value)) return value;
  return [];
}

function normalizePagination(value: unknown, recordCount: number): MukuPagination {
  const raw = asObject(value);
  const page = Math.max(1, Math.trunc(readNumber(raw.page, raw.currentPage, raw.current_page) ?? 1));
  const pageSize = Math.max(1, Math.trunc(readNumber(raw.pageSize, raw.page_size, raw.limit) ?? Math.max(recordCount, 1)));
  const total = Math.max(0, Math.trunc(readNumber(raw.total, raw.totalCount, raw.total_count) ?? recordCount));
  const totalPages = Math.max(1, Math.trunc(readNumber(raw.totalPages, raw.total_pages) ?? Math.ceil(total / pageSize)));
  return { page, pageSize, total, totalPages, hasNext: readBoolean(raw.hasNext, raw.has_next) ?? page < totalPages };
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values.map((value) => readString(value)).filter((value): value is string => value !== null);
  const valid = timestamps.filter((value) => !Number.isNaN(Date.parse(value))).sort((left, right) => Date.parse(right) - Date.parse(left));
  return valid[0] ?? timestamps[0] ?? null;
}

function normalizeMukuStatus(value: unknown): MukuStatus {
  const root = asObject(value);
  const data = asObject(root.data);
  const autoRefresh = asObject(root.autoRefresh);
  const statusObject = asObject(root.status);
  const connector = asObject(root.connection ?? root.connector ?? data.connection ?? data.connector);
  const run = asObject(root.sync ?? root.lastRun ?? root.run ?? data.sync ?? data.lastRun);
  const rawDatasets = readArray(root.datasets, data.datasets, connector.datasets);
  const datasetRows = rawDatasets.map(asObject).filter((row) => Object.keys(row).length > 0);
  const datasetStatuses = datasetRows.map((row) => readString(row.status)).filter((status): status is string => status !== null);
  const datasets = datasetRows.map((row, index): MukuDatasetState => ({
    dataset: readString(row.dataset) ?? `dataset-${index + 1}`,
    status: readString(row.status) ?? 'unknown',
    apiVersion: readString(row.apiVersion),
    generatedAt: readString(row.generatedAt),
    recordCount: readNumber(row.recordCount),
    lastSuccessAt: readString(row.lastSuccessAt),
    lastErrorCode: readString(row.lastErrorCode),
    updatedAt: readString(row.updatedAt),
  }));
  const aggregateStatus = datasetStatuses.some((status) => status === 'running')
    ? 'running'
    : datasetStatuses.some((status) => status === 'failed')
      ? 'failed'
      : datasetStatuses.some((status) => status === 'delayed')
        ? 'delayed'
        : datasetStatuses.length && datasetStatuses.every((status) => status === 'ready')
          ? 'ready'
          : datasetStatuses.length && datasetStatuses.every((status) => ['succeeded', 'unchanged', 'ready'].includes(status))
            ? 'succeeded'
            : null;
  const rawStatus = (readString(run.status, statusObject.status, connector.status, typeof root.status === 'string' ? root.status : null, data.status, aggregateStatus) ?? 'unknown').toLowerCase();
  const status: MukuSyncStatus = rawStatus.includes('run') || rawStatus.includes('progress')
    ? 'running'
    : rawStatus.includes('success') || rawStatus.includes('complete') || rawStatus === 'ok'
      ? 'succeeded'
      : rawStatus.includes('fail') || rawStatus.includes('error')
        ? 'failed'
        : rawStatus.includes('stale') || rawStatus.includes('delayed')
          ? 'stale'
          : rawStatus.includes('idle') || rawStatus.includes('ready')
            ? 'idle'
            : rawStatus.includes('unconfig')
              ? 'unconfigured'
              : 'unknown';
  const configured = readBoolean(root.configured, data.configured, statusObject.configured, connector.configured) ?? rawDatasets.length > 0;
  const latestError = datasetRows.find((row) => readString(row.lastErrorCode, row.errorCode));
  return {
    ok: true,
    configured,
    connected: readBoolean(root.connected, data.connected, statusObject.connected, connector.connected)
      ?? (configured && (status === 'succeeded' || status === 'idle')),
    readOnly: true,
    apiVersion: readString(root.apiVersion, root.api_version, data.apiVersion, statusObject.apiVersion, connector.apiVersion, ...datasetRows.map((row) => row.apiVersion)),
    datasetCount: Math.max(0, Math.trunc(readNumber(root.datasetCount, root.dataset_count, data.datasetCount, statusObject.datasetCount, connector.datasetCount) ?? rawDatasets.length)),
    status: configured ? status : 'unconfigured',
    errorCode: readString(root.errorCode, root.error_code, data.errorCode, statusObject.errorCode, connector.errorCode, run.errorCode, latestError?.lastErrorCode, latestError?.errorCode),
    lastSuccessAt: latestTimestamp([root.lastSuccessAt, root.last_success_at, data.lastSuccessAt, statusObject.lastSuccessAt, connector.lastSuccessAt, run.lastSuccessAt, run.completedAt, ...datasetRows.map((row) => row.lastSuccessAt)]),
    sourceGeneratedAt: latestTimestamp([root.sourceGeneratedAt, root.source_generated_at, data.sourceGeneratedAt, statusObject.sourceGeneratedAt, connector.sourceGeneratedAt, root.generatedAt, ...datasetRows.map((row) => row.generatedAt)]),
    syncedAt: latestTimestamp([root.syncedAt, root.synced_at, data.syncedAt, statusObject.syncedAt, connector.syncedAt, run.syncedAt, ...datasetRows.flatMap((row) => [row.updatedAt, row.lastSuccessAt])]),
    datasets,
    sourceStatusCount: readArray(root.sourceStatuses, data.sourceStatuses).length,
    autoRefresh: Object.keys(autoRefresh).length ? {
      mode: readString(autoRefresh.mode) ?? 'stale-while-revalidate',
      refreshTriggered: readBoolean(autoRefresh.refreshTriggered) ?? false,
      externalScheduleConfigured: readBoolean(autoRefresh.externalScheduleConfigured) ?? false,
    } : undefined,
  };
}

function normalizeMukuInventory(value: unknown): MukuInventoryPayload {
  const root = asObject(value);
  const data = asObject(root.data);
  const snapshot = asObject(root.snapshot ?? data.snapshot);
  const state = asObject(root.state ?? data.state);
  const rawRecords = readArray(root.records, root.items, root.inventory, root.data, data.records, data.items, data.inventory);
  const records = rawRecords.map((value, index): MukuInventoryRow => {
    const row = asObject(value);
    const sku = readString(row.sku, row.skuCode, row.sku_code, row.originalSku, row.itemSku);
    const warehouseCode = readString(row.warehouseCode, row.warehouse_code, row.warehouseId, row.warehouse_id);
    const recordKey = readString(row.recordKey, row.record_key, row.stableKey, row.stable_key, row.sourceRecordKey, row.source_record_key);
    return {
      id: readString(row.id, recordKey) ?? `${sku ?? 'unknown-sku'}:${warehouseCode ?? 'unknown-warehouse'}:${index}`,
      recordKey,
      sku,
      normalizedSku: readString(row.normalizedSku, row.normalized_sku, row.canonicalSku, row.canonical_sku),
      productName: readString(row.productName, row.product_name, row.skuName, row.sku_name, row.name, row.title),
      warehouseCode,
      warehouseName: readString(row.warehouseName, row.warehouse_name, row.warehouse),
      available: readNumber(row.available, row.availableQty, row.available_qty, row.availableQuantity, row.available_quantity),
      locked: readNumber(row.locked, row.lockedQty, row.locked_qty, row.reserved, row.reservedQty, row.reserved_qty),
      onHand: readNumber(row.onHand, row.on_hand, row.onHandQty, row.on_hand_qty, row.quantity, row.stock),
      inTransit: readNumber(row.inTransit, row.in_transit, row.inTransitQty, row.in_transit_qty, row.inboundQty, row.inbound_qty),
      ageDays: readNumber(row.ageDays, row.age_days, row.maxAgeDays, row.max_age_days, row.inventoryAgeDays),
      sourceUpdatedAt: readString(row.sourceUpdatedAt, row.source_updated_at, row.updatedAt, row.updated_at),
      ingestedAt: readString(row.ingestedAt, row.ingested_at, row.syncedAt, row.synced_at, row.snapshotAt, row.snapshot_at),
    };
  });
  const pagination = normalizePagination(root.pagination ?? data.pagination ?? root.meta ?? data.meta, records.length);
  return {
    ok: true,
    stale: readBoolean(root.stale, data.stale, snapshot.stale) ?? ['failed', 'delayed'].includes(readString(state.status) ?? ''),
    snapshotId: readString(root.snapshotId, root.snapshot_id, data.snapshotId, snapshot.id, snapshot.snapshotId, state.activeSnapshotId),
    generatedAt: readString(root.generatedAt, root.generated_at, data.generatedAt, snapshot.generatedAt, snapshot.generated_at, state.generatedAt),
    sourceUpdatedAt: readString(root.sourceUpdatedAt, root.source_updated_at, data.sourceUpdatedAt, snapshot.sourceUpdatedAt, state.sourceUpdatedAt),
    syncedAt: readString(root.syncedAt, root.synced_at, data.syncedAt, snapshot.syncedAt, snapshot.ingestedAt, state.lastSuccessAt, state.updatedAt),
    errorCode: readString(root.errorCode, root.error_code, data.errorCode, snapshot.errorCode, state.lastErrorCode),
    pagination,
    records,
  };
}

function normalizeMukuRisk(value: unknown): MukuRiskPayload {
  const root = asObject(value);
  const data = asObject(root.data);
  const snapshot = asObject(root.snapshot ?? data.snapshot);
  const state = asObject(root.state ?? data.state);
  const rawRecords = readArray(root.records, root.items, root.risks, root.data, data.records, data.items, data.risks);
  const records = rawRecords.map((value, index): MukuRiskRow => {
    const row = asObject(value);
    const sku = readString(row.sku, row.skuCode, row.sku_code, row.originalSku, row.itemSku);
    const reasons = readStringArray(row.reasons ?? row.riskReasons ?? row.risk_reasons ?? row.matchedBy ?? row.matched_by);
    return {
      id: readString(row.id, row.recordKey, row.record_key, row.stableKey, row.stable_key) ?? `${sku ?? 'unknown-sku'}:${index}`,
      sku,
      normalizedSku: readString(row.normalizedSku, row.normalized_sku, row.canonicalSku, row.canonical_sku),
      slowMoving: readBoolean(row.slowMoving, row.slow_moving, row.isSlowMoving, row.is_slow_moving),
      overAge: readBoolean(row.overAge, row.over_age, row.isOverAge, row.is_over_age),
      activeLowStock: readBoolean(row.activeLowStock, row.active_low_stock, row.isActiveLowStock, row.is_active_low_stock),
      reasons,
      available: readNumber(row.available, row.availableQty, row.available_qty),
      locked: readNumber(row.locked, row.lockedQty, row.locked_qty, row.reserved),
      onHand: readNumber(row.onHand, row.on_hand, row.onHandQty, row.on_hand_qty, row.quantity),
      sales30d: readNumber(row.sales30d, row.sales_30d, row.units30d, row.units_30d),
      ageDays: readNumber(row.ageDays, row.age_days, row.maxAgeDays, row.max_age_days),
      sourceUpdatedAt: readString(row.sourceUpdatedAt, row.source_updated_at, row.updatedAt, row.updated_at),
    };
  });
  return {
    ok: true,
    stale: readBoolean(root.stale, data.stale, snapshot.stale) ?? ['failed', 'delayed'].includes(readString(state.status) ?? ''),
    generatedAt: readString(root.generatedAt, root.generated_at, data.generatedAt, snapshot.generatedAt, snapshot.generated_at, state.generatedAt),
    sourceUpdatedAt: readString(root.sourceUpdatedAt, root.source_updated_at, data.sourceUpdatedAt, snapshot.sourceUpdatedAt, state.sourceUpdatedAt),
    syncedAt: readString(root.syncedAt, root.synced_at, data.syncedAt, snapshot.syncedAt, snapshot.ingestedAt, state.lastSuccessAt, state.updatedAt),
    errorCode: readString(root.errorCode, root.error_code, data.errorCode, snapshot.errorCode, state.lastErrorCode),
    pagination: normalizePagination(root.pagination ?? data.pagination ?? root.meta ?? data.meta, records.length),
    records,
  };
}

function normalizeMukuRuns(value: unknown): MukuRunsPayload {
  const root = asObject(value);
  const dataObject = asObject(root.data);
  const rawRecords = readArray(root.records, root.runs, root.data, dataObject.records, dataObject.runs);
  const records = rawRecords.map((value, index): MukuRun => {
    const row = asObject(value);
    return {
      id: readString(row.id) ?? `run-${index}`,
      dataset: readString(row.dataset) ?? 'unknown',
      status: readString(row.status) ?? 'unknown',
      recordCount: readNumber(row.recordCount),
      pageCount: readNumber(row.pageCount),
      errorCode: readString(row.errorCode),
      startedAt: readString(row.startedAt),
      finishedAt: readString(row.finishedAt),
      replayed: readBoolean(row.replayed),
    };
  });
  return { records, pagination: normalizePagination(root.pagination ?? dataObject.pagination, records.length) };
}

function mukuStatusPresentation(status: MukuStatus | null) {
  if (!status) return { label: '等待读取状态', className: '' };
  if (!status.configured || status.status === 'unconfigured') return { label: '未配置', className: '' };
  if (status.status === 'running') return { label: '同步中', className: 'pending' };
  if (status.status === 'failed') return { label: '最近同步失败', className: 'error' };
  if (status.status === 'stale') return { label: '数据源延迟', className: 'pending' };
  if (status.connected || status.status === 'succeeded' || status.status === 'idle') return { label: '只读连接正常', className: 'ready' };
  return { label: '状态未知', className: 'pending' };
}

function mukuRiskLabels(item: MukuRiskRow) {
  if (item.reasons.length) return item.reasons;
  const labels = [item.slowMoving === true ? '慢动销' : null, item.overAge === true ? '超龄' : null, item.activeLowStock === true ? '活跃低库存' : null].filter((label): label is string => label !== null);
  if (labels.length) return labels;
  if ([item.slowMoving, item.overAge, item.activeLowStock].every((value) => value === null)) return ['判定未知'];
  return ['未命中已知规则'];
}

function mukuDatasetLabel(dataset: string) {
  const labels: Record<string, string> = {
    inventory: '库存汇总',
    'inventory-details': '库存明细',
    'inventory-risk': '库存风险',
    'source-status': '来源状态',
  };
  return labels[dataset] ?? dataset;
}

function mukuRunStatusLabel(status: string) {
  if (status === 'ready') return '正常';
  if (status === 'delayed') return '延迟';
  if (status === 'succeeded') return '成功';
  if (status === 'unchanged') return '无变化';
  if (status === 'running') return '进行中';
  if (status === 'failed') return '失败';
  return '未知';
}

function formatNullableValue(value: string | number | null, suffix = '') {
  return value === null ? '未知' : `${value}${suffix}`;
}

function formatOptionalTime(value: string | null) {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : formatTime(value);
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
    const purchaseOrders = Array.isArray(body.purchaseOrders) ? body.purchaseOrders.map((order) => ({
      ...order,
      lines: Array.isArray(order.lines) ? order.lines.map((line) => ({
        ...line,
        remainingQuantity: Math.max(0, line.remainingQuantity ?? line.orderedQuantity - line.receivedQuantity),
        currency: line.currency ?? order.currency ?? null,
      })) : [],
      lineCount: order.lineCount ?? order.lines?.length ?? 0,
      orderedQuantity: order.orderedQuantity ?? order.lines?.reduce((sum, line) => sum + line.orderedQuantity, 0) ?? 0,
      receivedQuantity: order.receivedQuantity ?? order.lines?.reduce((sum, line) => sum + line.receivedQuantity, 0) ?? 0,
      currency: order.currency ?? null,
    })) : [];
    return {
      ...body,
      demands,
      summary: body.summary ?? emptyPurchaseSummary,
      requests,
      requestSummary: body.requestSummary ?? summarizePurchaseRequests(requests),
      members: Array.isArray(body.members) ? body.members : [],
      skuOptions: Array.isArray(body.skuOptions) ? body.skuOptions : [],
      suppliers: Array.isArray(body.suppliers) ? body.suppliers : [],
      warehouses: Array.isArray(body.warehouses) ? body.warehouses : [],
      purchaseOrders,
      purchaseReceipts: Array.isArray(body.purchaseReceipts) ? body.purchaseReceipts : [],
      procurementSummary: body.procurementSummary ?? summarizeProcurement(purchaseOrders, body.purchaseReceipts ?? [], body.suppliers ?? []),
    };
  }
  return {
    ok: true,
    readOnly: true,
    currentMemberId: null,
    developmentOpenAccess: false,
    demands,
    summary: body.summary ?? emptyPurchaseSummary,
    requests: [],
    requestSummary: emptyPurchaseRequestSummary,
    members: [],
    skuOptions: [],
    suppliers: [],
    warehouses: [],
    purchaseOrders: [],
    purchaseReceipts: [],
    procurementSummary: emptyProcurementSummary,
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

function summarizeProcurement(orders: PurchaseOrder[], receipts: PurchaseReceipt[], suppliers: PurchaseSupplier[]) {
  return {
    suppliers: suppliers.filter((supplier) => supplier.active).length,
    draftOrders: orders.filter((order) => order.status === 'draft').length,
    issuedOrders: orders.filter((order) => order.status === 'issued').length,
    partiallyReceivedOrders: orders.filter((order) => order.status === 'partially_received').length,
    receivedOrders: orders.filter((order) => order.status === 'received').length,
    pendingReceiptQuantity: orders.filter((order) => ['issued', 'partially_received'].includes(order.status)).reduce((sum, order) => sum + Math.max(0, order.orderedQuantity - order.receivedQuantity), 0),
    receiptCount: receipts.length,
    receivedQuantity: receipts.reduce((sum, receipt) => sum + receipt.totalQuantity, 0),
  };
}

function demandAvailableQuantity(demand: PurchaseDemand) {
  return Math.max(0, demand.availableQuantity ?? demand.requiredQuantity - (demand.allocatedQuantity ?? 0));
}

function planningRowConvertible(row: PurchasePlanningRow, readiness: PurchasePlanningPayload['readiness'], orderSourceReadiness = true) {
  return orderSourceReadiness
    && readiness !== 'stale'
    && row.blockers.length === 0
    && row.conversion.eligibleOrderQty > 0
    && !row.conversion.reasons.includes('policy_rounding_exceeds_order_gap');
}

function manualInventoryConfirmationEligible(row: PurchasePlanningRow) {
  return row.mukuAvailableQty === null && row.mukuMatchStatus !== 'ambiguous';
}

function planningDecisionLabel(decision: PurchasePlanningRow['decision']) {
  if (decision === 'buy') return '建议采购';
  if (decision === 'no_purchase') return '无需采购';
  return '需先处理';
}

function planningReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    inventory_stale: '库存快照已过期或正在刷新',
    muku_sku_unmapped: '尚未映射 MUKU SKU',
    muku_sku_ambiguous: 'MUKU SKU 映射存在歧义',
    muku_sku_missing_from_snapshot: '已映射 SKU 不在当前 MUKU 快照中',
    muku_available_unknown: 'MUKU 可用库存未知',
    safety_unknown: '安全库存未知，暂不追加安全库存',
    muku_inbound_unknown: 'MUKU 在途库存未知',
    source_inventory_stale: 'MUKU 出口已更新，但仓库源数据过旧',
    source_inventory_unknown: 'MUKU 出口已更新，但仓库源数据时间未知',
    inventory_source_stale: 'MUKU 出口已更新，但仓库源数据过旧',
    inventory_source_time_unknown: 'MUKU 出口已更新，但仓库源数据时间未知',
    inventory_source_time_invalid: 'MUKU 仓库源数据时间无效',
    receipt_not_reflected_in_muku: '本次到货尚未在 MUKU 库存中确认',
    order_source_unavailable: '官方订单源当前不可用',
    order_sync_stale: '官方订单同步已过期',
    no_official_order_source: '尚未接通可验证的官方订单源',
    global_inventory_scope: '当前按 MUKU 全仓汇总，未按区域可调拨性过滤',
    warehouse_scope_global_unverified: '当前按 MUKU 全仓汇总，未按区域可调拨性过滤',
    active_demand_partial_gap: '该订单需求已有部分采购，剩余缺口需人工复核',
    local_qa_excluded: '本地验收订单不作为官方采购需求',
    order_sync_time_unknown: '官方订单同步时间未知',
    order_sync_failed: '官方订单最近同步失败',
    safety_stock_without_purchase_demand: '安全库存部分没有真实订单需求，不能自动转申请',
    policy_rounding_exceeds_order_gap: 'MOQ 或包装取整超出真实订单缺口',
    order_demand_already_in_active_request: '部分订单需求已进入有效采购申请',
    manual_inventory_confirmation: 'MUKU 可用量缺失，当前使用 24 小时内的人工库存确认',
    manual_inventory_confirmation_expired: '人工库存确认已过期，已恢复库存未知阻断',
  };
  return labels[reason] ?? reason;
}

function formatOrderSourceWarning(planning: PurchasePlanningPayload) {
  const unavailable = planning.orderSources.filter((source) => !source.ready);
  if (!unavailable.length) return planning.orderSourceBlockers.map(planningReasonLabel).join('；') || '官方订单源暂不可用。';
  return unavailable.map((source) => {
    const reason = source.reasons.map(planningReasonLabel).join('、') || '状态未就绪';
    return `${source.storeName}：${reason}${source.lastSuccessAt ? `（最近同步 ${formatOptionalTime(source.lastSuccessAt)}）` : ''}`;
  }).join('；');
}

function planningPrimaryBlocker(row: PurchasePlanningRow) {
  const reason = row.blockers[0]
    ?? row.conversion.reasons.find((item) => item === 'policy_rounding_exceeds_order_gap')
    ?? row.conversion.reasons[0];
  return reason ? planningReasonLabel(reason) : '当前不可转换';
}

function formatPlanningEquation(row: PurchasePlanningRow) {
  const safety = row.calculationParts.safetyStockQty === null ? '未知（按 0 暂算）' : String(row.calculationParts.safetyStockQty);
  const available = row.calculationParts.effectiveAvailableQty === null ? '未知' : String(row.calculationParts.effectiveAvailableQty);
  const raw = row.calculationParts.rawTotalGapQty === null ? '未知' : String(row.calculationParts.rawTotalGapQty);
  const rounded = row.calculationParts.roundedRecommendedQty === null ? '未知' : String(row.calculationParts.roundedRecommendedQty);
  return `max(0, ${row.calculationParts.orderDemandQty} + ${safety} - ${available} - ${row.calculationParts.erpPurchaseChainCoverageQty}) = ${raw}，策略取整后 ${rounded}`;
}

function planningAvailableSourceLabel(row: PurchasePlanningRow) {
  if (row.availableQtySource === 'manual_confirmation') {
    const expiry = row.inventoryConfirmation?.expiresAt;
    return `人工确认${expiry ? ` · 有效至 ${formatOptionalTime(expiry)}` : ''}`;
  }
  if (row.availableQtySource === 'muku') return 'MUKU 仓库源';
  if (row.inventoryConfirmation && !row.inventoryConfirmation.active) {
    return `可用库存未知 · 人工确认已于 ${formatOptionalTime(row.inventoryConfirmation.expiresAt)} 过期`;
  }
  return '可用库存未知';
}

function optionalFormInteger(data: FormData, name: string) {
  const raw = String(data.get(name) ?? '').trim();
  return raw ? Number(raw) : null;
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
