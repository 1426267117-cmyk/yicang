import { env } from 'cloudflare:workers';
import type {
  CreatePlanningPurchaseRequestInput,
  UpsertMukuSkuMappingInput,
  UpsertSkuInventoryConfirmationInput,
  UpsertSkuProcurementPolicyInput,
} from './contracts';
import { developmentOpenAccessEnabled } from './access-policy';
import { HttpError, requirePermission, type UserContext } from './db';
import { evaluateMukuFreshness } from './muku-freshness-service';
import { evaluateOrderSourceReadiness } from './order-source-readiness';
import { buildProcurementOperationsStatus } from './procurement-operations';
import { SHOPIFY_STORE_CANDIDATES } from './connectors/shopify/config';
import {
  createPurchaseRequestFromAllocations,
  getPurchaseRequest,
} from './purchase-workflow-service';

export const PURCHASE_PLANNING_CALCULATION_VERSION = 'procurement-planning-v2';
const DEFAULT_SAFETY_DAYS = 14;
const DEFAULT_INVENTORY_SOURCE_MAX_AGE_MINUTES = 48 * 60;
const DEFAULT_ORDER_SYNC_MAX_AGE_MINUTES = 30;
const INVENTORY_CONFIRMATION_TTL_HOURS = 24;

type SkuRow = { id: string; code: string; name: string };
type DemandRow = {
  id: string;
  mapped_sku_id: string;
  required_quantity: number;
  source_updated_at: string;
};
type ActiveRequestLineRow = {
  id: string;
  active: number;
  purchase_demand_id: string;
  sku_id: string;
  requested_quantity: number;
  purchase_demand_status: string;
  request_status: string;
  purchase_order_status: string | null;
  ordered_quantity: number | null;
  received_quantity: number | null;
  latest_receipt_at: string | null;
  latest_inventory_event_at: string | null;
};
type MappingRow = {
  id: string;
  muku_sku: string;
  normalized_muku_sku: string;
  sku_id: string;
  mapping_source: 'manual' | 'exact';
  updated_at: string;
};
type PolicyRow = {
  id: string;
  sku_id: string;
  safety_days: number;
  safety_stock_qty: number | null;
  moq: number | null;
  pack_size: number | null;
  lead_time_days: number | null;
  preferred_supplier_id: string | null;
  supplier_name: string | null;
  updated_at: string;
};
type InventoryConfirmationRow = {
  id: string;
  sku_id: string;
  confirmed_available_qty: number;
  scope: 'all_warehouses';
  confirmed_at: string;
  expires_at: string;
  note: string;
  confirmed_by: string;
  confirmed_by_email: string;
  created_at: string;
  updated_at: string;
};
type InventoryRow = {
  sku: string | null;
  available_qty: number | null;
  inbound_qty: number | null;
  warehouse_code: string | null;
  source_id: string | null;
  inventory_kind: string | null;
  source_updated_at: string | null;
};
type RiskRow = {
  sku: string | null;
  sales_30d: number | null;
  source_updated_at: string | null;
};
type NeedsMappingRow = {
  id: string;
  raw_sku: string | null;
  normalized_sku: string | null;
  required_quantity: number;
  platform: string;
  source_order_id: string;
  source_order_line_id: string;
};
type OrderSourceRow = {
  id: string;
  platform: string;
  connector_key: string;
  display_name: string;
  credential_ref: string;
  identity_verified_at: string;
  last_successful_sync_at: string | null;
  sync_status: string | null;
  sync_last_success_at: string | null;
  completed_watermark: string | null;
  sync_last_error_code: string | null;
  sync_last_error_at: string | null;
};

type MukuAssignment = {
  mukuSku: string;
  skuId: string;
  source: 'manual' | 'exact';
  mappingId: string | null;
  mappingUpdatedAt: string | null;
};

export type PurchasePlanningRow = Awaited<ReturnType<typeof buildPlanningRow>>;

export type PurchasePlanningEvidence = {
  schemaVersion: 1;
  rows: Array<{
    planRowId: string;
    skuId: string;
    recommendationVersion: string;
    allocations: Array<{ demandId: string; quantity: number }>;
  }>;
};

export async function getPurchasePlanning(
  db: D1Database,
  user: UserContext,
  options: {
    now?: Date;
    maxAgeMinutes?: number;
    sourceMaxAgeMinutes?: number;
    runtimeEnv?: Record<string, unknown>;
    excludePurchaseRequestId?: string;
  } = {},
) {
  requirePermission(user, 'purchase:read');
  const runtimeEnv = options.runtimeEnv ?? env as unknown as Record<string, unknown>;
  const freshness = await evaluateMukuFreshness(db, user.tenantId, {
    now: options.now,
    maxAgeMinutes: options.maxAgeMinutes,
    runtimeEnv,
  });
  const sourceFreshnessMaxAgeMinutes = options.sourceMaxAgeMinutes
    ?? boundedEnvInteger(
      runtimeEnv.MUKU_INVENTORY_SOURCE_MAX_AGE_MINUTES,
      DEFAULT_INVENTORY_SOURCE_MAX_AGE_MINUTES,
      5,
      30 * 24 * 60,
    );
  const orderSyncMaxAgeMinutes = boundedEnvInteger(
    runtimeEnv.ERP_ORDER_SYNC_MAX_AGE_MINUTES,
    DEFAULT_ORDER_SYNC_MAX_AGE_MINUTES,
    5,
    24 * 60,
  );
  const inventoryDataset = freshness.datasets.find((item) => item.dataset === 'inventory') ?? null;
  const riskDataset = freshness.datasets.find((item) => item.dataset === 'inventory-risk') ?? null;

  const [
    skuResult,
    demandResult,
    activeLineResult,
    mappingResult,
    policyResult,
    inventoryConfirmationResult,
    needsMappingResult,
    orderSourceResult,
    authorizedShopifyResult,
  ] = await Promise.all([
    db.prepare(`
      SELECT id, code, name FROM skus
      WHERE tenant_id = ? AND active = 1
      ORDER BY code, id
    `).bind(user.tenantId).all<SkuRow>(),
    db.prepare(`
      SELECT id, mapped_sku_id, required_quantity, source_updated_at
      FROM purchase_demands
      WHERE tenant_id = ? AND status = 'open' AND mapped_sku_id IS NOT NULL
      ORDER BY source_updated_at, id
    `).bind(user.tenantId).all<DemandRow>(),
    db.prepare(`
      SELECT
        line.id,
        line.active,
        line.purchase_demand_id,
        line.sku_id,
        line.requested_quantity,
        pd.status AS purchase_demand_status,
        pr.status AS request_status,
        po.status AS purchase_order_status,
        pol.ordered_quantity,
        pol.received_quantity,
        (
          SELECT MAX(receipt.received_at)
          FROM purchase_receipt_lines receipt_line
          JOIN purchase_receipts receipt
            ON receipt.id = receipt_line.purchase_receipt_id
            AND receipt.tenant_id = receipt_line.tenant_id
          WHERE receipt_line.tenant_id = line.tenant_id
            AND receipt_line.purchase_order_line_id = pol.id
            AND receipt_line.quantity > COALESCE((
              SELECT SUM(correction_line.quantity)
              FROM purchase_receipt_correction_lines correction_line
              JOIN purchase_receipt_corrections correction
                ON correction.id = correction_line.correction_id
                AND correction.tenant_id = correction_line.tenant_id
              WHERE correction_line.tenant_id = receipt_line.tenant_id
                AND correction_line.purchase_receipt_line_id = receipt_line.id
                AND correction.status = 'posted'
            ), 0)
        ) AS latest_receipt_at
        ,(
          SELECT MAX(inventory_event.event_at)
          FROM (
            SELECT MAX(receipt.received_at, receipt.created_at) AS event_at
            FROM purchase_receipt_lines receipt_line
            JOIN purchase_receipts receipt
              ON receipt.id = receipt_line.purchase_receipt_id
              AND receipt.tenant_id = receipt_line.tenant_id
            WHERE receipt_line.tenant_id = line.tenant_id
              AND receipt_line.purchase_order_line_id = pol.id
            UNION ALL
            SELECT correction.created_at AS event_at
            FROM purchase_receipt_correction_lines correction_line
            JOIN purchase_receipt_corrections correction
              ON correction.id = correction_line.correction_id
              AND correction.tenant_id = correction_line.tenant_id
            JOIN purchase_receipt_lines receipt_line
              ON receipt_line.id = correction_line.purchase_receipt_line_id
              AND receipt_line.tenant_id = correction_line.tenant_id
            WHERE correction_line.tenant_id = line.tenant_id
              AND receipt_line.purchase_order_line_id = pol.id
              AND correction.status = 'posted'
          ) inventory_event
        ) AS latest_inventory_event_at
      FROM purchase_request_lines line
      JOIN purchase_requests pr
        ON pr.id = line.request_id AND pr.tenant_id = line.tenant_id
      JOIN purchase_demands pd
        ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
      LEFT JOIN purchase_orders po
        ON po.purchase_request_id = pr.id AND po.tenant_id = pr.tenant_id AND po.status <> 'cancelled'
      LEFT JOIN purchase_order_lines pol
        ON pol.purchase_order_id = po.id AND pol.purchase_request_line_id = line.id
        AND pol.tenant_id = line.tenant_id
      WHERE line.tenant_id = ?
        AND (line.active = 1 OR po.status = 'closed_short')
        AND (? IS NULL OR line.request_id <> ?)
      ORDER BY line.id
    `).bind(
      user.tenantId,
      options.excludePurchaseRequestId ?? null,
      options.excludePurchaseRequestId ?? null,
    ).all<ActiveRequestLineRow>(),
    db.prepare(`
      SELECT id, muku_sku, normalized_muku_sku, sku_id, mapping_source, updated_at
      FROM muku_sku_mappings
      WHERE tenant_id = ?
      ORDER BY muku_sku, id
    `).bind(user.tenantId).all<MappingRow>(),
    db.prepare(`
      SELECT policy.id, policy.sku_id, policy.safety_days, policy.safety_stock_qty,
             policy.moq, policy.pack_size, policy.lead_time_days,
             policy.preferred_supplier_id, supplier.name AS supplier_name, policy.updated_at
      FROM sku_procurement_policies policy
      LEFT JOIN suppliers supplier
        ON supplier.id = policy.preferred_supplier_id AND supplier.tenant_id = policy.tenant_id
      WHERE policy.tenant_id = ?
      ORDER BY policy.sku_id
    `).bind(user.tenantId).all<PolicyRow>(),
    db.prepare(`
      SELECT id, sku_id, confirmed_available_qty, scope, confirmed_at, expires_at,
             note, confirmed_by, confirmed_by_email, created_at, updated_at
      FROM sku_inventory_confirmations
      WHERE tenant_id = ?
      ORDER BY sku_id
    `).bind(user.tenantId).all<InventoryConfirmationRow>(),
    db.prepare(`
      SELECT id, raw_sku, normalized_sku, required_quantity, platform,
             source_order_id, source_order_line_id
      FROM purchase_demands
      WHERE tenant_id = ? AND status = 'needs_mapping'
      ORDER BY source_updated_at DESC, id
      LIMIT 500
    `).bind(user.tenantId).all<NeedsMappingRow>(),
    db.prepare(`
      SELECT store.id, store.platform, store.connector_key, store.display_name,
             store.credential_ref, store.identity_verified_at,
             store.last_successful_sync_at,
             state.status AS sync_status,
             state.last_success_at AS sync_last_success_at,
             state.completed_watermark,
             state.last_error_code AS sync_last_error_code,
             state.last_error_at AS sync_last_error_at
      FROM platform_stores store
      LEFT JOIN connector_sync_state state
        ON state.platform_store_id = store.id AND state.tenant_id = store.tenant_id
        AND state.connector = store.platform AND state.resource = 'orders'
      WHERE store.tenant_id = ? AND store.active = 1
      ORDER BY store.platform, store.display_name, store.id
    `).bind(user.tenantId).all<OrderSourceRow>(),
    db.prepare(`
      SELECT store_key
      FROM connector_credentials
      WHERE tenant_id = ? AND platform = 'shopify'
      ORDER BY store_key
    `).bind(user.tenantId).all<{ store_key: string }>(),
  ]);

  const [inventoryResult, riskResult] = await Promise.all([
    inventoryDataset?.activeSnapshotId
      ? db.prepare(`
          SELECT sku, available_qty, inbound_qty, warehouse_code, source_id,
                 inventory_kind, source_updated_at
          FROM muku_inventory_records
          WHERE tenant_id = ? AND snapshot_id = ? AND sku IS NOT NULL
          ORDER BY sku, warehouse_code, stable_key
        `).bind(user.tenantId, inventoryDataset.activeSnapshotId).all<InventoryRow>()
      : Promise.resolve({ results: [] as InventoryRow[] }),
    riskDataset?.activeSnapshotId
      ? db.prepare(`
          SELECT sku, sales_30d, source_updated_at
          FROM muku_inventory_risk_records
          WHERE tenant_id = ? AND snapshot_id = ? AND sku IS NOT NULL
          ORDER BY sku, stable_key
        `).bind(user.tenantId, riskDataset.activeSnapshotId).all<RiskRow>()
      : Promise.resolve({ results: [] as RiskRow[] }),
  ]);

  const skus = skuResult.results;
  const skuById = new Map(skus.map((sku) => [sku.id, sku]));
  const skuIdsByNormalizedCode = groupBy(skus, (sku) => normalizeSkuForMatching(sku.code));
  const inventoryBySku = groupBy(
    inventoryResult.results.filter((row): row is InventoryRow & { sku: string } => Boolean(row.sku)),
    (row) => row.sku,
  );
  const riskBySku = groupBy(
    riskResult.results.filter((row): row is RiskRow & { sku: string } => Boolean(row.sku)),
    (row) => row.sku,
  );
  const manualBySource = new Map(mappingResult.results.map((mapping) => [mapping.muku_sku, mapping]));
  const assignments: MukuAssignment[] = [];
  const ambiguousCandidates = new Map<string, string[]>();
  const currentMukuSkus = [...inventoryBySku.keys()].sort();

  for (const mapping of mappingResult.results) {
    if (!skuById.has(mapping.sku_id)) continue;
    assignments.push({
      mukuSku: mapping.muku_sku,
      skuId: mapping.sku_id,
      source: mapping.mapping_source,
      mappingId: mapping.id,
      mappingUpdatedAt: mapping.updated_at,
    });
  }
  for (const mukuSku of currentMukuSkus) {
    if (manualBySource.has(mukuSku)) continue;
    const candidates = skuIdsByNormalizedCode.get(normalizeSkuForMatching(mukuSku)) ?? [];
    if (candidates.length === 1) {
      assignments.push({
        mukuSku,
        skuId: candidates[0]!.id,
        source: 'exact',
        mappingId: null,
        mappingUpdatedAt: null,
      });
    } else if (candidates.length > 1) {
      ambiguousCandidates.set(mukuSku, candidates.map((candidate) => candidate.id));
    }
  }
  const uniqueAssignments = dedupeAssignments(assignments);
  const assignmentsBySku = groupBy(uniqueAssignments, (assignment) => assignment.skuId);
  const demandsBySku = groupBy(demandResult.results, (demand) => demand.mapped_sku_id);
  const activeLinesBySku = groupBy(activeLineResult.results, (line) => line.sku_id);
  const activeLineByDemand = new Map(
    activeLineResult.results
      .filter((line) => line.active === 1)
      .map((line) => [line.purchase_demand_id, line]),
  );
  const policyBySku = new Map(policyResult.results.map((policy) => [policy.sku_id, policy]));
  const inventoryConfirmationBySku = new Map(
    inventoryConfirmationResult.results.map((confirmation) => [confirmation.sku_id, confirmation]),
  );
  const relevantSkuIds = new Set<string>([
    ...demandsBySku.keys(),
    ...policyBySku.keys(),
    ...inventoryConfirmationBySku.keys(),
    ...assignmentsBySku.keys(),
    ...activeLinesBySku.keys(),
  ]);

  const rows = await Promise.all(
    [...relevantSkuIds]
      .map((skuId) => skuById.get(skuId))
      .filter((sku): sku is SkuRow => Boolean(sku))
      .sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id))
      .map((sku) => buildPlanningRow({
        sku,
        demands: demandsBySku.get(sku.id) ?? [],
        activeLines: activeLinesBySku.get(sku.id) ?? [],
        activeLineByDemand,
        assignments: assignmentsBySku.get(sku.id) ?? [],
        ambiguousMukuSkus: [...ambiguousCandidates.entries()]
          .filter(([, candidateSkuIds]) => candidateSkuIds.includes(sku.id))
          .map(([mukuSku]) => mukuSku),
        policy: policyBySku.get(sku.id) ?? null,
        inventoryConfirmation: inventoryConfirmationBySku.get(sku.id) ?? null,
        inventoryBySku,
        riskBySku,
        inventoryDataset,
        riskDataset,
        inventoryReady: freshness.readyForProcurement,
        checkedAt: freshness.checkedAt,
        sourceFreshnessMaxAgeMinutes,
      })),
  );

  const assignedSources = new Set(uniqueAssignments.map((assignment) => assignment.mukuSku));
  const mukuExceptions = currentMukuSkus
    .filter((mukuSku) => !assignedSources.has(mukuSku))
    .slice(0, 500)
    .map((mukuSku) => {
      const records = inventoryBySku.get(mukuSku) ?? [];
      return {
        mukuSku,
        status: ambiguousCandidates.has(mukuSku) ? 'ambiguous' as const : 'unmapped' as const,
        candidateSkuIds: ambiguousCandidates.get(mukuSku) ?? [],
        availableQty: aggregateNullable(records, (row) => row.available_qty),
        inboundQty: aggregateNullable(records, (row) => row.inbound_qty),
      };
    });
  const orderSources = orderSourceResult.results.map((source) => {
    const sourceReadiness = evaluateOrderSourceReadiness({
      credentialRef: source.credential_ref,
      connectorKey: source.connector_key,
      identityVerifiedAt: source.identity_verified_at,
      lastSuccessfulSyncAt: source.last_successful_sync_at,
      syncLastSuccessAt: source.sync_last_success_at,
      syncStatus: source.sync_status,
      completedWatermark: source.completed_watermark,
    }, {
      checkedAt: freshness.checkedAt,
      maxAgeMinutes: orderSyncMaxAgeMinutes,
    });
    return {
      storeId: source.id,
      platform: source.platform,
      storeKey: source.connector_key,
      storeName: source.display_name,
      identityVerifiedAt: source.identity_verified_at,
      official: sourceReadiness.official,
      ready: sourceReadiness.ready,
      lastSuccessAt: sourceReadiness.lastSuccessAt,
      ageMinutes: sourceReadiness.ageMinutes,
      completedWatermarkAt: sourceReadiness.completedWatermarkAt,
      watermarkAgeMinutes: sourceReadiness.watermarkAgeMinutes,
      syncStatus: source.sync_status ?? 'not_started',
      lastErrorCode: source.sync_last_error_code,
      lastErrorAt: source.sync_last_error_at,
      reasons: sourceReadiness.reasons,
    };
  });
  const officialOrderSources = orderSources.filter((source) => source.official);
  const activeShopifyOrderSources = officialOrderSources.filter(
    (source) => source.platform === 'shopify',
  );
  const orderSourceBlockers = [...new Set([
    ...(officialOrderSources.length === 0 ? ['no_official_order_source'] : []),
    ...officialOrderSources.flatMap((source) => source.reasons),
  ])];
  const orderSourceReadiness = orderSourceBlockers.length === 0;
  const readiness = !freshness.readyForProcurement
    ? 'stale' as const
    : !orderSourceReadiness
      ? (orderSourceBlockers.includes('no_official_order_source') ? 'blocked' as const : 'stale' as const)
    : rows.some((row) => row.decision === 'blocked')
      ? 'blocked' as const
      : 'ready' as const;
  const operations = buildProcurementOperationsStatus({
    freshness,
    orderSources,
    shopifyAuthorizedStoreKeys: authorizedShopifyResult.results.map((row) => row.store_key),
    orderSyncMaxAgeMinutes,
    runtimeEnv,
  });

  return {
    ok: true as const,
    readiness,
    calculationVersion: PURCHASE_PLANNING_CALCULATION_VERSION,
    formula: {
      target: '订单需求 + 安全库存',
      coverage: '有效可用库存（MUKU 优先，缺失时可用有效人工确认）+ ERP 采购链覆盖量',
      recommendation: 'max(0, target - coverage)，再按 MOQ/包装量展示建议',
      deduplication: '无有效采购单时按 active purchase_request_line；有采购单后仅按 ordered-received，采购单不再重复扣减',
      mukuInbound: 'MUKU 在途不直接扣减；非零且未逐笔证明不与 ERP 采购链重叠时，阻断自动采购',
    },
    storeCoverage: {
      mode: activeShopifyOrderSources.length < SHOPIFY_STORE_CANDIDATES.length
        ? 'pilot' as const
        : 'full' as const,
      candidateStoreCount: SHOPIFY_STORE_CANDIDATES.length,
      activeOfficialStoreCount: activeShopifyOrderSources.length,
      activeStoreKeys: activeShopifyOrderSources.map((source) => source.storeKey),
      missingCandidateStoreKeys: SHOPIFY_STORE_CANDIDATES
        .map((candidate) => candidate.key)
        .filter((storeKey) => !activeShopifyOrderSources.some((source) => source.storeKey === storeKey)),
    },
    orderSourceReadiness,
    orderSourceMaxAgeMinutes: orderSyncMaxAgeMinutes,
    orderSourceBlockers,
    orderSources,
    operations,
    freshness,
    summary: {
      rows: rows.length,
      buy: rows.filter((row) => row.decision === 'buy').length,
      noPurchase: rows.filter((row) => row.decision === 'no_purchase').length,
      blocked: rows.filter((row) => row.decision === 'blocked').length,
      recommendedQty: rows.some((row) => row.recommendedQty === null)
        ? null
        : sumKnown(rows.map((row) => row.recommendedQty)),
      knownRecommendedQty: sumKnown(rows.map((row) => row.recommendedQty)),
      unknownRecommendationRows: rows.filter((row) => row.recommendedQty === null).length,
      convertibleOrderQty: rows.reduce((sum, row) => sum + row.conversion.eligibleOrderQty, 0),
      needsShopifyMapping: needsMappingResult.results.length,
      needsMukuMapping: mukuExceptions.length,
    },
    rows,
    mappingExceptions: {
      shopify: needsMappingResult.results.map((row) => ({
        demandId: row.id,
        platform: row.platform,
        rawSku: row.raw_sku,
        normalizedSku: row.normalized_sku,
        requiredQuantity: Number(row.required_quantity),
        sourceOrderId: row.source_order_id,
        sourceOrderLineId: row.source_order_line_id,
      })),
      muku: mukuExceptions,
      erp: rows
        .filter((row) => row.mukuMatchStatus === 'unmapped' || row.mukuMatchStatus === 'ambiguous')
        .map((row) => ({
          planRowId: row.planRowId,
          skuId: row.skuId,
          skuCode: row.skuCode,
          status: row.mukuMatchStatus,
          ambiguousMukuSkus: row.ambiguousMukuSkus,
        })),
    },
    readOnly: true as const,
  };
}

async function buildPlanningRow(input: {
  sku: SkuRow;
  demands: DemandRow[];
  activeLines: ActiveRequestLineRow[];
  activeLineByDemand: Map<string, ActiveRequestLineRow>;
  assignments: MukuAssignment[];
  ambiguousMukuSkus: string[];
  policy: PolicyRow | null;
  inventoryConfirmation: InventoryConfirmationRow | null;
  inventoryBySku: Map<string, (InventoryRow & { sku: string })[]>;
  riskBySku: Map<string, (RiskRow & { sku: string })[]>;
  inventoryDataset: Awaited<ReturnType<typeof evaluateMukuFreshness>>['datasets'][number] | null;
  riskDataset: Awaited<ReturnType<typeof evaluateMukuFreshness>>['datasets'][number] | null;
  inventoryReady: boolean;
  checkedAt: string;
  sourceFreshnessMaxAgeMinutes: number;
}) {
  const policy = input.policy;
  const safetyDays = Number(policy?.safety_days ?? DEFAULT_SAFETY_DAYS);
  const orderDemandQty = input.demands.reduce((sum, demand) => sum + Number(demand.required_quantity), 0);
  const coveringRequestLines = input.activeLines.filter(
    (line) => line.active === 1 && line.purchase_demand_status === 'open',
  );
  const erpPurchaseChainCoverageQty = coveringRequestLines.reduce(
    (sum, line) => sum + (line.purchase_order_status
      ? Math.max(0, Number(line.ordered_quantity ?? 0) - Number(line.received_quantity ?? 0))
      : Number(line.requested_quantity)),
    0,
  );
  const sourceDetails = input.assignments.map((assignment) => {
    const allInventoryRecords = input.inventoryBySku.get(assignment.mukuSku) ?? [];
    const inventoryRecords = allInventoryRecords.filter(isAvailableInventorySource);
    const riskRecords = input.riskBySku.get(assignment.mukuSku) ?? [];
    return {
      sku: assignment.mukuSku,
      mappingSource: assignment.source,
      mappingId: assignment.mappingId,
      availableQty: aggregateNullable(inventoryRecords, (row) => row.available_qty),
      inboundQty: aggregateNullable(allInventoryRecords, (row) => row.inbound_qty),
      sales30d: aggregateNullable(riskRecords, (row) => row.sales_30d),
      inventoryRecordCount: inventoryRecords.length,
      availableValueCount: inventoryRecords.filter((row) => row.available_qty !== null).length,
      inventorySourceUpdatedAt: latestTimestamp(inventoryRecords.map((row) => row.source_updated_at)),
      inventoryOldestSourceUpdatedAt: earliestTimestamp(
        inventoryRecords.map((row) => row.source_updated_at),
      ),
      inventorySourceTimeUnknown: inventoryRecords.some((row) => !row.source_updated_at),
      inventorySourceTimeInvalid: inventoryRecords.some(
        (row) => Boolean(row.source_updated_at) && Number.isNaN(Date.parse(row.source_updated_at!)),
      ),
      inventoryKinds: [...new Set(inventoryRecords.map((row) => row.inventory_kind).filter(Boolean))],
      sourceIds: [...new Set(inventoryRecords.map((row) => row.source_id).filter(Boolean))],
      riskSourceUpdatedAt: latestTimestamp(riskRecords.map((row) => row.source_updated_at)),
      mappingUpdatedAt: assignment.mappingUpdatedAt,
    };
  });
  const hasManual = input.assignments.some((assignment) => assignment.source === 'manual');
  const mukuMatchStatus = input.assignments.length > 0
    ? (hasManual ? 'manual' as const : 'exact' as const)
    : input.ambiguousMukuSkus.length > 0
      ? 'ambiguous' as const
      : 'unmapped' as const;
  const mukuAvailableQty = aggregateNullable(sourceDetails, (source) => source.availableQty);
  const mukuInboundQty = aggregateNullable(sourceDetails, (source) => source.inboundQty);
  const inventoryRecordUpdatedAt = latestTimestamp(
    sourceDetails.map((source) => source.inventorySourceUpdatedAt),
  );
  const inventoryOldestRecordUpdatedAt = earliestTimestamp(
    sourceDetails.map((source) => source.inventoryOldestSourceUpdatedAt),
  );
  const inventorySourceAgeMinutes = timestampAgeMinutes(
    inventoryOldestRecordUpdatedAt,
    input.checkedAt,
  );
  const inventorySourceTimeUnknown = sourceDetails.some(
    (source) => source.inventorySourceTimeUnknown || source.inventoryRecordCount === 0,
  );
  const inventorySourceTimeInvalid = sourceDetails.some((source) => source.inventorySourceTimeInvalid)
    || (inventorySourceAgeMinutes !== null && inventorySourceAgeMinutes < -5);
  const inventorySourceFreshness = inventorySourceTimeInvalid
    ? 'invalid' as const
    : inventorySourceTimeUnknown || inventorySourceAgeMinutes === null
      ? 'unknown' as const
      : inventorySourceAgeMinutes > input.sourceFreshnessMaxAgeMinutes
        ? 'stale' as const
        : 'fresh' as const;
  const confirmationTimeValid = Boolean(
    input.inventoryConfirmation
    && !Number.isNaN(Date.parse(input.inventoryConfirmation.confirmed_at))
    && !Number.isNaN(Date.parse(input.inventoryConfirmation.expires_at)),
  );
  const confirmationActive = Boolean(
    input.inventoryConfirmation
    && confirmationTimeValid
    && Date.parse(input.inventoryConfirmation.confirmed_at) <= Date.parse(input.checkedAt)
    && Date.parse(input.inventoryConfirmation.expires_at) > Date.parse(input.checkedAt),
  );
  const hasExplicitMukuAvailableValue = sourceDetails.some(
    (source) => source.availableValueCount > 0,
  );
  const manualInventoryFallbackUsed = mukuAvailableQty === null
    && !hasExplicitMukuAvailableValue
    && confirmationActive
    && mukuMatchStatus !== 'ambiguous';
  const effectiveAvailableQty = mukuAvailableQty ?? (manualInventoryFallbackUsed
    ? Number(input.inventoryConfirmation!.confirmed_available_qty)
    : null);
  const availableQtySource = mukuAvailableQty !== null
    ? 'muku' as const
    : manualInventoryFallbackUsed
      ? 'manual_confirmation' as const
      : 'unknown' as const;
  const latestReceiptAt = latestTimestamp(input.activeLines.map((line) => line.latest_receipt_at));
  const latestInventoryEventAt = latestTimestamp(
    input.activeLines.map((line) => line.latest_inventory_event_at),
  );
  const receiptReflectedInMuku = latestInventoryEventAt === null
    ? null
    : inventoryRecordUpdatedAt !== null
      && Date.parse(inventoryRecordUpdatedAt) >= Date.parse(latestInventoryEventAt);
  const riskUsable = Boolean(input.riskDataset?.fresh && input.riskDataset.activeSnapshotId);
  const sales30d = riskUsable
    ? aggregateNullable(sourceDetails, (source) => source.sales30d)
    : null;
  const explicitSafety = policy?.safety_stock_qty ?? null;
  const safetyStockQty = explicitSafety !== null
    ? Number(explicitSafety)
    : sales30d === null
      ? null
      : Math.ceil((sales30d / 30) * safetyDays);
  const safetyStockBasis = explicitSafety !== null
    ? 'explicit' as const
    : safetyStockQty !== null
      ? 'sales30d' as const
      : 'unknown' as const;

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!input.inventoryReady) blockers.push('inventory_stale');
  if (mukuMatchStatus === 'unmapped' && !manualInventoryFallbackUsed) blockers.push('muku_sku_unmapped');
  if (mukuMatchStatus === 'ambiguous') blockers.push('muku_sku_ambiguous');
  if (!manualInventoryFallbackUsed
    && input.assignments.length > 0
    && sourceDetails.some((source) => source.inventoryRecordCount === 0)) {
    blockers.push('muku_sku_missing_from_snapshot');
  }
  if (!manualInventoryFallbackUsed && input.assignments.length > 0 && mukuAvailableQty === null) {
    blockers.push('muku_available_unknown');
  }
  if (latestInventoryEventAt !== null && receiptReflectedInMuku !== true) {
    blockers.push('receipt_not_reflected_in_muku');
  }
  if (mukuInboundQty !== null && mukuInboundQty > 0) {
    blockers.push('muku_inbound_unreconciled');
  }
  if (!manualInventoryFallbackUsed && inventorySourceFreshness === 'unknown') {
    blockers.push('inventory_source_time_unknown');
  }
  if (inventorySourceFreshness === 'invalid') {
    blockers.push('inventory_source_time_invalid');
  }
  if (inventorySourceFreshness === 'stale') {
    blockers.push('inventory_source_stale');
  }
  if (manualInventoryFallbackUsed) warnings.push('manual_inventory_confirmation');
  if (input.inventoryConfirmation && !confirmationActive) warnings.push('manual_inventory_confirmation_expired');
  if (safetyStockQty === null) warnings.push('safety_unknown');
  if (mukuInboundQty === null) warnings.push('muku_inbound_unknown');
  warnings.push('warehouse_scope_global_unverified');

  let rawOrderGapQty: number | null = null;
  let rawTotalGapQty: number | null = null;
  let recommendedQty: number | null = null;
  let eligibleOrderQty = 0;
  let blockedRecommendationQty = 0;
  let safetyOnlyQty = 0;
  let policyRoundingQty = 0;
  let demandAllocations: Array<{ demandId: string; quantity: number }> = [];
  if (blockers.length === 0 && effectiveAvailableQty !== null) {
    rawOrderGapQty = Math.max(
      0,
      orderDemandQty - effectiveAvailableQty - erpPurchaseChainCoverageQty,
    );
    rawTotalGapQty = Math.max(
      0,
      orderDemandQty + (safetyStockQty ?? 0) - effectiveAvailableQty - erpPurchaseChainCoverageQty,
    );
    recommendedQty = roundRecommendation(rawTotalGapQty, policy?.moq ?? null, policy?.pack_size ?? null);
    safetyOnlyQty = Math.max(0, rawTotalGapQty - rawOrderGapQty);
    policyRoundingQty = Math.max(0, recommendedQty - rawTotalGapQty);
    const eligibleDemands = input.demands.filter((demand) => !input.activeLineByDemand.has(demand.id));
    const convertibleCapacity = eligibleDemands.reduce(
      (sum, demand) => sum + Number(demand.required_quantity),
      0,
    );
    eligibleOrderQty = Math.min(rawOrderGapQty, convertibleCapacity);
    demandAllocations = allocateDeterministically(eligibleDemands, eligibleOrderQty);
    blockedRecommendationQty = Math.max(0, recommendedQty - eligibleOrderQty);
  }

  const conversionReasons: string[] = [];
  if (blockers.length > 0) conversionReasons.push(...blockers);
  if (safetyOnlyQty > 0) conversionReasons.push('safety_stock_without_purchase_demand');
  if (policyRoundingQty > 0) conversionReasons.push('policy_rounding_exceeds_order_gap');
  if (rawOrderGapQty !== null && rawOrderGapQty > eligibleOrderQty) {
    conversionReasons.push('order_demand_already_in_active_request');
  }

  const decision = blockers.length > 0
    ? 'blocked' as const
    : Number(recommendedQty ?? 0) > 0
      ? 'buy' as const
      : 'no_purchase' as const;
  const explanations = [
    `订单确认需求 ${orderDemandQty} 件。`,
    mukuAvailableQty === null
      ? 'MUKU 全仓汇总可用量未知；当前未按区域或仓库可调拨性过滤。'
      : `MUKU 全仓汇总可用量 ${mukuAvailableQty} 件；当前未按区域或仓库可调拨性过滤。`,
    `ERP 采购链覆盖 ${erpPurchaseChainCoverageQty} 件；无有效采购单时按申请量，有采购单后仅按未收量，采购单不再重复扣减。`,
    '发生收货或冲正时，只有 MUKU 库存源时间已越过 ERP 实际入账事件才继续计算；否则阻断建议。',
    'MUKU 在途不直接抵扣；非零且尚未与 ERP 采购单逐笔对账时阻断自动采购。',
  ];
  if (manualInventoryFallbackUsed) {
    explanations.push(
      `MUKU 仓库可用量缺失；本次按人工确认的全仓可用量 ${effectiveAvailableQty} 件计算，确认有效至 ${input.inventoryConfirmation!.expires_at}。`,
    );
  } else if (input.inventoryConfirmation && !confirmationActive) {
    explanations.push(`人工库存确认已于 ${input.inventoryConfirmation.expires_at} 过期，不参与本次计算。`);
  } else if (input.inventoryConfirmation && mukuAvailableQty !== null) {
    explanations.push('当前 MUKU 已提供明确仓库可用量，优先使用 MUKU；人工确认仅保留审计展示。');
  }
  if (safetyStockQty === null) {
    explanations.push('近 30 天销量或安全库存未知；不阻断已确认订单缺口，仅暂不追加安全库存。');
  } else {
    explanations.push(`安全库存目标 ${safetyStockQty} 件（${safetyStockBasis === 'explicit' ? '人工策略' : `${safetyDays} 天销量`}）。`);
  }
  if (blockedRecommendationQty > 0) {
    explanations.push(`其中 ${blockedRecommendationQty} 件没有可安全关联的订单需求，不会伪造需求或自动下单。`);
  }
  if (rawOrderGapQty !== null && rawOrderGapQty > eligibleOrderQty) {
    explanations.push('部分缺口已关联 active 采购申请，不能再次分配；需人工处理旧采购链后再重算。');
  }

  const versionInput = {
    algorithm: PURCHASE_PLANNING_CALCULATION_VERSION,
    sku: input.sku,
    demands: input.demands.map((demand) => ({
      id: demand.id,
      requiredQuantity: Number(demand.required_quantity),
      sourceUpdatedAt: demand.source_updated_at,
    })),
    purchaseChain: input.activeLines.map((line) => ({
      id: line.id,
      active: line.active === 1,
      demandId: line.purchase_demand_id,
      requestedQuantity: Number(line.requested_quantity),
      purchaseDemandStatus: line.purchase_demand_status,
      requestStatus: line.request_status,
      purchaseOrderStatus: line.purchase_order_status,
      orderedQuantity: line.ordered_quantity,
      receivedQuantity: line.received_quantity,
      latestReceiptAt: line.latest_receipt_at,
      latestInventoryEventAt: line.latest_inventory_event_at,
    })),
    mappings: sourceDetails,
    ambiguousMukuSkus: [...input.ambiguousMukuSkus].sort(),
    policy: policy ? {
      safetyDays,
      safetyStockQty: policy.safety_stock_qty,
      moq: policy.moq,
      packSize: policy.pack_size,
      leadTimeDays: policy.lead_time_days,
      preferredSupplierId: policy.preferred_supplier_id,
      updatedAt: policy.updated_at,
    } : null,
    inventoryConfirmation: input.inventoryConfirmation ? {
      id: input.inventoryConfirmation.id,
      confirmedAvailableQty: Number(input.inventoryConfirmation.confirmed_available_qty),
      scope: input.inventoryConfirmation.scope,
      confirmedAt: input.inventoryConfirmation.confirmed_at,
      expiresAt: input.inventoryConfirmation.expires_at,
      note: input.inventoryConfirmation.note,
      confirmedBy: input.inventoryConfirmation.confirmed_by,
      confirmedByEmail: input.inventoryConfirmation.confirmed_by_email,
      active: confirmationActive,
      used: manualInventoryFallbackUsed,
      updatedAt: input.inventoryConfirmation.updated_at,
    } : null,
    inventorySnapshotId: input.inventoryDataset?.activeSnapshotId ?? null,
    riskSnapshotId: input.riskDataset?.activeSnapshotId ?? null,
  };
  const recommendationVersion = await hashPayload(versionInput);

  return {
    planRowId: `procurement:${input.sku.id}`,
    calculationVersion: PURCHASE_PLANNING_CALCULATION_VERSION,
    recommendationVersion,
    skuId: input.sku.id,
    skuCode: input.sku.code,
    skuName: input.sku.name,
    decision,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    explanations,
    mukuMatchStatus,
    ambiguousMukuSkus: [...input.ambiguousMukuSkus].sort(),
    mukuSkus: sourceDetails,
    orderDemandQty,
    activeRequestQty: erpPurchaseChainCoverageQty,
    unallocatedDemandQty: input.demands
      .filter((demand) => !input.activeLineByDemand.has(demand.id))
      .reduce((sum, demand) => sum + Number(demand.required_quantity), 0),
    mukuAvailableQty,
    effectiveAvailableQty,
    availableQtySource,
    mukuInboundQty,
    inventoryScope: 'all_muku_warehouses' as const,
    erpPurchaseChainCoverageQty,
    erpOpenPoQty: input.activeLines.filter((line) => line.active === 1).reduce(
      (sum, line) => sum + Math.max(0, Number(line.ordered_quantity ?? 0) - Number(line.received_quantity ?? 0)),
      0,
    ),
    erpReceivedQty: input.activeLines.reduce((sum, line) => sum + Number(line.received_quantity ?? 0), 0),
    sales30d,
    safetyDays,
    safetyStockQty,
    safetyStockBasis,
    rawGapQty: rawTotalGapQty,
    recommendedQty,
    policy: {
      moq: policy?.moq ?? null,
      packSize: policy?.pack_size ?? null,
      leadTimeDays: policy?.lead_time_days ?? null,
      preferredSupplierId: policy?.preferred_supplier_id ?? null,
      preferredSupplierName: policy?.supplier_name ?? null,
    },
    calculationParts: {
      orderDemandQty,
      safetyStockQty,
      mukuAvailableQty,
      effectiveAvailableQty,
      availableQtySource,
      erpPurchaseChainCoverageQty,
      mukuInboundQty,
      mukuInboundDeducted: false,
      erpOpenPoDeductedSeparately: false,
      rawOrderGapQty,
      rawTotalGapQty,
      moq: policy?.moq ?? null,
      packSize: policy?.pack_size ?? null,
      roundedRecommendedQty: recommendedQty,
    },
    sourceTimes: {
      inventoryGeneratedAt: input.inventoryDataset?.generatedAt ?? null,
      inventoryLastSuccessAt: input.inventoryDataset?.lastSuccessAt ?? null,
      inventoryRecordUpdatedAt,
      inventoryOldestRecordUpdatedAt,
      inventorySourceAgeMinutes,
      inventorySourceFreshness,
      inventorySourceMaxAgeMinutes: input.sourceFreshnessMaxAgeMinutes,
      latestReceiptAt,
      latestInventoryEventAt,
      receiptReflectedInMuku,
      riskGeneratedAt: input.riskDataset?.generatedAt ?? null,
      riskLastSuccessAt: input.riskDataset?.lastSuccessAt ?? null,
      riskRecordUpdatedAt: latestTimestamp(sourceDetails.map((source) => source.riskSourceUpdatedAt)),
    },
    inventoryConfirmation: input.inventoryConfirmation ? {
      id: input.inventoryConfirmation.id,
      confirmedAvailableQty: Number(input.inventoryConfirmation.confirmed_available_qty),
      scope: input.inventoryConfirmation.scope,
      confirmedAt: input.inventoryConfirmation.confirmed_at,
      expiresAt: input.inventoryConfirmation.expires_at,
      note: input.inventoryConfirmation.note,
      confirmedBy: input.inventoryConfirmation.confirmed_by,
      confirmedByEmail: input.inventoryConfirmation.confirmed_by_email,
      active: confirmationActive,
      used: manualInventoryFallbackUsed,
    } : null,
    conversion: {
      eligibleOrderQty,
      blockedRecommendationQty,
      safetyOnlyQty,
      policyRoundingQty,
      conversionBlocked: blockers.length > 0 || blockedRecommendationQty > 0,
      reasons: [...new Set(conversionReasons)],
    },
    demandAllocations,
  };
}

export async function upsertMukuSkuMapping(
  db: D1Database,
  user: UserContext,
  input: UpsertMukuSkuMappingInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:mapping');
  validateIdempotencyKey(idempotencyKey);
  const requestHash = await hashPayload(input);
  const replay = await replayMutation(
    db,
    user.tenantId,
    idempotencyKey,
    'UPSERT_MUKU_SKU_MAPPING',
    requestHash,
  );
  if (replay) {
    const mapping = await loadMapping(db, user.tenantId, replay.entityId);
    return { mapping, replayed: true };
  }

  const [sku, source, before] = await Promise.all([
    db.prepare(`
      SELECT id, code, name FROM skus
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, input.skuId).first<SkuRow>(),
    db.prepare(`
      SELECT record.sku
      FROM muku_dataset_state state
      JOIN muku_inventory_records record
        ON record.snapshot_id = state.active_snapshot_id AND record.tenant_id = state.tenant_id
      WHERE state.tenant_id = ? AND state.dataset = 'inventory'
        AND record.sku = ?
      LIMIT 1
    `).bind(user.tenantId, input.mukuSku).first<{ sku: string }>(),
    db.prepare(`
      SELECT id, muku_sku, normalized_muku_sku, sku_id, mapping_source, updated_at
      FROM muku_sku_mappings
      WHERE tenant_id = ? AND muku_sku = ?
      LIMIT 1
    `).bind(user.tenantId, input.mukuSku).first<MappingRow>(),
  ]);
  if (!sku) throw new HttpError(404, 'ERP SKU 不存在或已停用', 'ERP_SKU_NOT_FOUND');
  if (!source) {
    throw new HttpError(409, '当前 MUKU 有效库存快照中不存在该 SKU', 'MUKU_SKU_NOT_IN_ACTIVE_SNAPSHOT');
  }

  const now = new Date().toISOString();
  const mappingId = before?.id ?? crypto.randomUUID();
  const normalized = normalizeSkuForMatching(input.mukuSku);
  const after = {
    id: mappingId,
    mukuSku: input.mukuSku,
    normalizedMukuSku: normalized,
    skuId: sku.id,
    skuCode: sku.code,
    mappingSource: 'manual' as const,
    updatedAt: now,
  };
  await db.batch([
    db.prepare(`
      INSERT INTO muku_sku_mappings (
        id, tenant_id, muku_sku, normalized_muku_sku, sku_id, mapping_source,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)
      ON CONFLICT(tenant_id, muku_sku) DO UPDATE SET
        normalized_muku_sku = excluded.normalized_muku_sku,
        sku_id = excluded.sku_id,
        mapping_source = 'manual',
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).bind(
      mappingId,
      user.tenantId,
      input.mukuSku,
      normalized,
      sku.id,
      user.id,
      user.id,
      now,
      now,
    ),
    auditStatement(db, {
      user,
      action: 'UPSERT_MUKU_SKU_MAPPING',
      entityType: 'muku_sku_mapping',
      entityId: mappingId,
      beforeJson: before ? JSON.stringify(before) : null,
      afterJson: JSON.stringify({ ...after, requestHash }),
      idempotencyKey,
      now,
    }),
  ]);
  return { mapping: after, replayed: false };
}

export async function upsertSkuProcurementPolicy(
  db: D1Database,
  user: UserContext,
  input: UpsertSkuProcurementPolicyInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:mapping');
  validateIdempotencyKey(idempotencyKey);
  const requestHash = await hashPayload(input);
  const replay = await replayMutation(
    db,
    user.tenantId,
    idempotencyKey,
    'UPSERT_SKU_PROCUREMENT_POLICY',
    requestHash,
  );
  if (replay) {
    const policy = await loadPolicy(db, user.tenantId, replay.entityId);
    return { policy, replayed: true };
  }
  const [sku, before] = await Promise.all([
    db.prepare(`
      SELECT id, code, name FROM skus
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, input.skuId).first<SkuRow>(),
    db.prepare(`
      SELECT id, sku_id, safety_days, safety_stock_qty, moq, pack_size,
             lead_time_days, preferred_supplier_id, updated_at
      FROM sku_procurement_policies
      WHERE tenant_id = ? AND sku_id = ?
      LIMIT 1
    `).bind(user.tenantId, input.skuId).first<Omit<PolicyRow, 'supplier_name'>>(),
  ]);
  if (!sku) throw new HttpError(404, 'ERP SKU 不存在或已停用', 'ERP_SKU_NOT_FOUND');
  if (input.preferredSupplierId !== undefined && input.preferredSupplierId !== null) {
    const supplier = await db.prepare(`
      SELECT id FROM suppliers
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, input.preferredSupplierId).first<{ id: string }>();
    if (!supplier) throw new HttpError(404, '首选供应商不存在或已停用', 'SUPPLIER_NOT_FOUND');
  }

  const now = new Date().toISOString();
  const policyId = before?.id ?? crypto.randomUUID();
  const merged = {
    id: policyId,
    skuId: sku.id,
    skuCode: sku.code,
    safetyDays: input.safetyDays ?? Number(before?.safety_days ?? DEFAULT_SAFETY_DAYS),
    safetyStockQty: input.safetyStockQty !== undefined
      ? input.safetyStockQty
      : before?.safety_stock_qty ?? null,
    moq: input.moq !== undefined ? input.moq : before?.moq ?? null,
    packSize: input.packSize !== undefined ? input.packSize : before?.pack_size ?? null,
    leadTimeDays: input.leadTimeDays !== undefined
      ? input.leadTimeDays
      : before?.lead_time_days ?? null,
    preferredSupplierId: input.preferredSupplierId !== undefined
      ? input.preferredSupplierId
      : before?.preferred_supplier_id ?? null,
    updatedAt: now,
  };
  await db.batch([
    db.prepare(`
      INSERT INTO sku_procurement_policies (
        id, tenant_id, sku_id, safety_days, safety_stock_qty, moq, pack_size,
        lead_time_days, preferred_supplier_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, sku_id) DO UPDATE SET
        safety_days = excluded.safety_days,
        safety_stock_qty = excluded.safety_stock_qty,
        moq = excluded.moq,
        pack_size = excluded.pack_size,
        lead_time_days = excluded.lead_time_days,
        preferred_supplier_id = excluded.preferred_supplier_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).bind(
      policyId,
      user.tenantId,
      sku.id,
      merged.safetyDays,
      merged.safetyStockQty,
      merged.moq,
      merged.packSize,
      merged.leadTimeDays,
      merged.preferredSupplierId,
      user.id,
      user.id,
      now,
      now,
    ),
    auditStatement(db, {
      user,
      action: 'UPSERT_SKU_PROCUREMENT_POLICY',
      entityType: 'sku_procurement_policy',
      entityId: policyId,
      beforeJson: before ? JSON.stringify(before) : null,
      afterJson: JSON.stringify({ ...merged, requestHash }),
      idempotencyKey,
      now,
    }),
  ]);
  return { policy: merged, replayed: false };
}

export async function upsertSkuInventoryConfirmation(
  db: D1Database,
  user: UserContext,
  input: UpsertSkuInventoryConfirmationInput,
  idempotencyKey: string,
  options: { now?: Date } = {},
) {
  requirePermission(user, 'purchase:mapping');
  validateIdempotencyKey(idempotencyKey);
  const requestHash = await hashPayload(input);
  const replay = await replayMutation(
    db,
    user.tenantId,
    idempotencyKey,
    'UPSERT_SKU_INVENTORY_CONFIRMATION',
    requestHash,
  );
  if (replay) {
    const confirmation = parseInventoryConfirmationAudit(replay.after)
      ?? await loadInventoryConfirmation(db, user.tenantId, replay.entityId);
    return { confirmation, replayed: true };
  }

  const [sku, before] = await Promise.all([
    db.prepare(`
      SELECT id, code, name FROM skus
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, input.skuId).first<SkuRow>(),
    db.prepare(`
      SELECT id, sku_id, confirmed_available_qty, scope, confirmed_at, expires_at,
             note, confirmed_by, confirmed_by_email, created_at, updated_at
      FROM sku_inventory_confirmations
      WHERE tenant_id = ? AND sku_id = ?
      LIMIT 1
    `).bind(user.tenantId, input.skuId).first<InventoryConfirmationRow>(),
  ]);
  if (!sku) throw new HttpError(404, 'ERP SKU 不存在或已停用', 'ERP_SKU_NOT_FOUND');

  const clock = options.now ?? new Date();
  if (Number.isNaN(clock.getTime())) {
    throw new HttpError(400, '确认时间无效', 'INVALID_INVENTORY_CONFIRMATION_TIME');
  }
  const confirmedAt = clock.toISOString();
  const expiresAt = new Date(
    clock.getTime() + INVENTORY_CONFIRMATION_TTL_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const confirmationId = before?.id ?? await stableInventoryConfirmationId(user.tenantId, sku.id);
  const after = {
    id: confirmationId,
    skuId: sku.id,
    skuCode: sku.code,
    confirmedAvailableQty: input.confirmedAvailableQty,
    scope: 'all_warehouses' as const,
    confirmedAt,
    expiresAt,
    note: input.note,
    confirmedBy: user.id,
    confirmedByEmail: user.email,
    updatedAt: confirmedAt,
  };

  await db.batch([
    db.prepare(`
      INSERT INTO sku_inventory_confirmations (
        id, tenant_id, sku_id, confirmed_available_qty, scope, confirmed_at,
        expires_at, note, confirmed_by, confirmed_by_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'all_warehouses', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        confirmed_available_qty = excluded.confirmed_available_qty,
        scope = excluded.scope,
        confirmed_at = excluded.confirmed_at,
        expires_at = excluded.expires_at,
        note = excluded.note,
        confirmed_by = excluded.confirmed_by,
        confirmed_by_email = excluded.confirmed_by_email,
        updated_at = excluded.updated_at
    `).bind(
      confirmationId,
      user.tenantId,
      sku.id,
      input.confirmedAvailableQty,
      confirmedAt,
      expiresAt,
      input.note,
      user.id,
      user.email,
      confirmedAt,
      confirmedAt,
    ),
    auditStatement(db, {
      user,
      action: 'UPSERT_SKU_INVENTORY_CONFIRMATION',
      entityType: 'sku_inventory_confirmation',
      entityId: confirmationId,
      beforeJson: before ? JSON.stringify(before) : null,
      afterJson: JSON.stringify({ ...after, requestHash }),
      idempotencyKey,
      now: confirmedAt,
    }),
  ]);
  return { confirmation: after, replayed: false };
}

export async function createPurchaseRequestFromPlanning(
  db: D1Database,
  user: UserContext,
  input: CreatePlanningPurchaseRequestInput,
  idempotencyKey: string,
  options: {
    now?: Date;
    maxAgeMinutes?: number;
    sourceMaxAgeMinutes?: number;
    runtimeEnv?: Record<string, unknown>;
  } = {},
) {
  requirePermission(user, 'purchase:create');
  validateIdempotencyKey(idempotencyKey);
  const normalizedSelections = [...input.selections]
    .sort((left, right) => left.planRowId.localeCompare(right.planRowId));
  const planningInputHash = await hashPayload({
    selections: normalizedSelections,
    purchaserMemberId: input.purchaserMemberId,
    reviewerMemberId: input.reviewerMemberId,
    note: input.note?.trim() || null,
  });
  const existing = await db.prepare(`
    SELECT pr.id, log.action, log.after_json
    FROM purchase_requests pr
    LEFT JOIN audit_logs log
      ON log.tenant_id = pr.tenant_id AND log.entity_id = pr.id
      AND log.idempotency_key = pr.idempotency_key
    WHERE pr.tenant_id = ? AND pr.idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{
    id: string;
    action: string | null;
    after_json: string | null;
  }>();
  if (existing) {
    const audit = parseJsonObject(existing.after_json);
    if (existing.action !== 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
      || audit?.planningInputHash !== planningInputHash) {
      throw new HttpError(409, '同一幂等键不能用于不同采购建议', 'IDEMPOTENCY_CONFLICT');
    }
    return { request: await getPurchaseRequest(db, user.tenantId, existing.id), replayed: true };
  }

  const plan = await getPurchasePlanning(db, user, options);
  if (!plan.orderSourceReadiness) {
    throw new HttpError(
      409,
      plan.orderSourceBlockers.includes('no_official_order_source')
        ? '没有已验证且可用于采购的官方订单来源'
        : '官方订单同步未知、失败或已过期，请先刷新订单',
      'PURCHASE_ORDER_SOURCE_NOT_READY',
    );
  }
  const rowById = new Map(plan.rows.map((row) => [row.planRowId, row]));
  const allocations: Array<{ demandId: string; requestedQuantity: number }> = [];
  const versions: string[] = [];
  const evidenceRows: PurchasePlanningEvidence['rows'] = [];
  for (const selection of normalizedSelections) {
    const row = rowById.get(selection.planRowId);
    if (!row) throw new HttpError(404, '采购建议不存在或不在当前数据范围内', 'PURCHASE_PLAN_ROW_NOT_FOUND');
    if (row.recommendationVersion !== selection.recommendationVersion) {
      throw new HttpError(409, '采购建议所依据的数据已变化，请刷新后重试', 'PURCHASE_RECOMMENDATION_STALE');
    }
    if (row.blockers.length > 0) {
      throw new HttpError(409, '采购建议存在库存或映射阻断项，不能转申请', 'PURCHASE_PLAN_BLOCKED');
    }
    if (row.conversion.eligibleOrderQty <= 0 || row.demandAllocations.length === 0) {
      throw new HttpError(409, '该建议没有可安全关联的订单需求', 'PURCHASE_PLAN_NOT_CONVERTIBLE');
    }
    if (row.conversion.reasons.includes('policy_rounding_exceeds_order_gap')) {
      throw new HttpError(
        409,
        'MOQ 或包装量高于可关联订单缺口，请调整策略后再转申请',
        'PURCHASE_POLICY_ROUNDING_NOT_CONVERTIBLE',
      );
    }
    allocations.push(...row.demandAllocations.map((allocation) => ({
      demandId: allocation.demandId,
      requestedQuantity: allocation.quantity,
    })));
    versions.push(row.recommendationVersion);
    evidenceRows.push({
      planRowId: row.planRowId,
      skuId: row.skuId,
      recommendationVersion: row.recommendationVersion,
      allocations: row.demandAllocations.map((allocation) => ({ ...allocation })),
    });
  }
  const runtimeEnv = options.runtimeEnv ?? env as unknown as Record<string, unknown>;
  return createPurchaseRequestFromAllocations(db, user, {
    purchaserMemberId: input.purchaserMemberId,
    reviewerMemberId: input.reviewerMemberId,
    note: input.note,
    allocations,
    recommendationVersions: versions,
    planningInputHash,
    planningEvidence: { schemaVersion: 1, rows: evidenceRows },
  }, idempotencyKey, {
    developmentOpenAccess: developmentOpenAccessEnabled(runtimeEnv),
  });
}

export async function assertPurchaseRequestPlanningEvidenceCurrent(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
  evidence: PurchasePlanningEvidence,
  options: {
    now?: Date;
    maxAgeMinutes?: number;
    sourceMaxAgeMinutes?: number;
    runtimeEnv?: Record<string, unknown>;
  } = {},
) {
  const current = await getPurchasePlanning(db, user, {
    ...options,
    excludePurchaseRequestId: purchaseRequestId,
  });
  if (!current.orderSourceReadiness) {
    throw new HttpError(
      409,
      '官方订单同步未知、失败或已过期，请刷新订单和采购建议后重试',
      'PURCHASE_RECOMMENDATION_STALE',
    );
  }
  const rowById = new Map(current.rows.map((row) => [row.planRowId, row]));
  for (const expected of evidence.rows) {
    const row = rowById.get(expected.planRowId);
    const allocations = row?.demandAllocations
      .map((allocation) => ({ ...allocation }))
      .sort(comparePlanningAllocations);
    const expectedAllocations = expected.allocations
      .map((allocation) => ({ ...allocation }))
      .sort(comparePlanningAllocations);
    if (!row
      || row.skuId !== expected.skuId
      || row.recommendationVersion !== expected.recommendationVersion
      || row.blockers.length > 0
      || JSON.stringify(allocations) !== JSON.stringify(expectedAllocations)) {
      throw new HttpError(
        409,
        '采购建议所依据的订单、库存、确认有效期或策略已变化，请刷新建议并重新生成申请',
        'PURCHASE_RECOMMENDATION_STALE',
      );
    }
  }
}

function comparePlanningAllocations(
  left: { demandId: string; quantity: number },
  right: { demandId: string; quantity: number },
) {
  return left.demandId.localeCompare(right.demandId) || left.quantity - right.quantity;
}

function allocateDeterministically(demands: DemandRow[], quantity: number) {
  let remaining = quantity;
  const allocations: Array<{ demandId: string; quantity: number }> = [];
  for (const demand of [...demands].sort(
    (left, right) => left.source_updated_at.localeCompare(right.source_updated_at)
      || left.id.localeCompare(right.id),
  )) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Number(demand.required_quantity));
    if (allocated > 0) allocations.push({ demandId: demand.id, quantity: allocated });
    remaining -= allocated;
  }
  return allocations;
}

function roundRecommendation(raw: number, moq: number | null, packSize: number | null) {
  if (raw <= 0) return 0;
  let result = Math.max(raw, Number(moq ?? 0));
  if (packSize !== null && packSize > 0) result = Math.ceil(result / packSize) * packSize;
  return result;
}

function aggregateNullable<T>(rows: T[], select: (row: T) => number | null) {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const value = select(row);
    if (value === null || !Number.isSafeInteger(Number(value)) || Number(value) < 0) return null;
    total += Number(value);
  }
  return total;
}

function groupBy<T>(rows: T[], select: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = select(row);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function dedupeAssignments(assignments: MukuAssignment[]) {
  const bySource = new Map<string, MukuAssignment>();
  for (const assignment of assignments) {
    const existing = bySource.get(assignment.mukuSku);
    if (!existing || assignment.source === 'manual') bySource.set(assignment.mukuSku, assignment);
  }
  return [...bySource.values()].sort(
    (left, right) => left.mukuSku.localeCompare(right.mukuSku) || left.skuId.localeCompare(right.skuId),
  );
}

export function normalizeSkuForMatching(value: string) {
  return value.trim().toUpperCase();
}

function latestTimestamp(values: Array<string | null>) {
  const valid = values.filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)));
  return valid.sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function earliestTimestamp(values: Array<string | null>) {
  const valid = values.filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)));
  return valid.sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function timestampAgeMinutes(value: string | null, checkedAt: string) {
  if (!value || Number.isNaN(Date.parse(value)) || Number.isNaN(Date.parse(checkedAt))) return null;
  return Math.round(((Date.parse(checkedAt) - Date.parse(value)) / 60_000) * 10) / 10;
}

function isAvailableInventorySource(row: InventoryRow) {
  const kind = row.inventory_kind?.trim().toLowerCase().replaceAll('-', '_') ?? '';
  return kind === 'warehouse';
}

function boundedEnvInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sumKnown(values: Array<number | null>) {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

async function loadMapping(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`
    SELECT mapping.id, mapping.muku_sku, mapping.normalized_muku_sku,
           mapping.sku_id, sku.code AS sku_code, mapping.mapping_source, mapping.updated_at
    FROM muku_sku_mappings mapping
    JOIN skus sku ON sku.id = mapping.sku_id AND sku.tenant_id = mapping.tenant_id
    WHERE mapping.tenant_id = ? AND mapping.id = ?
    LIMIT 1
  `).bind(tenantId, id).first<{
    id: string;
    muku_sku: string;
    normalized_muku_sku: string;
    sku_id: string;
    sku_code: string;
    mapping_source: string;
    updated_at: string;
  }>();
  if (!row) throw new HttpError(404, 'MUKU SKU 映射不存在', 'MUKU_SKU_MAPPING_NOT_FOUND');
  return {
    id: row.id,
    mukuSku: row.muku_sku,
    normalizedMukuSku: row.normalized_muku_sku,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    mappingSource: row.mapping_source,
    updatedAt: row.updated_at,
  };
}

async function loadPolicy(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`
    SELECT policy.id, policy.sku_id, sku.code AS sku_code, policy.safety_days,
           policy.safety_stock_qty, policy.moq, policy.pack_size, policy.lead_time_days,
           policy.preferred_supplier_id, policy.updated_at
    FROM sku_procurement_policies policy
    JOIN skus sku ON sku.id = policy.sku_id AND sku.tenant_id = policy.tenant_id
    WHERE policy.tenant_id = ? AND policy.id = ?
    LIMIT 1
  `).bind(tenantId, id).first<{
    id: string;
    sku_id: string;
    sku_code: string;
    safety_days: number;
    safety_stock_qty: number | null;
    moq: number | null;
    pack_size: number | null;
    lead_time_days: number | null;
    preferred_supplier_id: string | null;
    updated_at: string;
  }>();
  if (!row) throw new HttpError(404, '采购策略不存在', 'PROCUREMENT_POLICY_NOT_FOUND');
  return {
    id: row.id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    safetyDays: Number(row.safety_days),
    safetyStockQty: row.safety_stock_qty,
    moq: row.moq,
    packSize: row.pack_size,
    leadTimeDays: row.lead_time_days,
    preferredSupplierId: row.preferred_supplier_id,
    updatedAt: row.updated_at,
  };
}

async function loadInventoryConfirmation(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`
    SELECT confirmation.id, confirmation.sku_id, sku.code AS sku_code,
           confirmation.confirmed_available_qty, confirmation.scope,
           confirmation.confirmed_at, confirmation.expires_at, confirmation.note,
           confirmation.confirmed_by, confirmation.confirmed_by_email,
           confirmation.updated_at
    FROM sku_inventory_confirmations confirmation
    JOIN skus sku
      ON sku.id = confirmation.sku_id AND sku.tenant_id = confirmation.tenant_id
    WHERE confirmation.tenant_id = ? AND confirmation.id = ?
    LIMIT 1
  `).bind(tenantId, id).first<{
    id: string;
    sku_id: string;
    sku_code: string;
    confirmed_available_qty: number;
    scope: 'all_warehouses';
    confirmed_at: string;
    expires_at: string;
    note: string;
    confirmed_by: string;
    confirmed_by_email: string;
    updated_at: string;
  }>();
  if (!row) {
    throw new HttpError(404, '人工库存确认不存在', 'INVENTORY_CONFIRMATION_NOT_FOUND');
  }
  return {
    id: row.id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    confirmedAvailableQty: Number(row.confirmed_available_qty),
    scope: row.scope,
    confirmedAt: row.confirmed_at,
    expiresAt: row.expires_at,
    note: row.note,
    confirmedBy: row.confirmed_by,
    confirmedByEmail: row.confirmed_by_email,
    updatedAt: row.updated_at,
  };
}

function parseInventoryConfirmationAudit(value: Record<string, unknown> | null) {
  if (!value
    || typeof value.id !== 'string'
    || typeof value.skuId !== 'string'
    || typeof value.skuCode !== 'string'
    || !Number.isSafeInteger(value.confirmedAvailableQty)
    || Number(value.confirmedAvailableQty) < 0
    || value.scope !== 'all_warehouses'
    || typeof value.confirmedAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || typeof value.note !== 'string'
    || typeof value.confirmedBy !== 'string'
    || typeof value.confirmedByEmail !== 'string'
    || typeof value.updatedAt !== 'string') {
    return null;
  }
  return {
    id: value.id,
    skuId: value.skuId,
    skuCode: value.skuCode,
    confirmedAvailableQty: Number(value.confirmedAvailableQty),
    scope: value.scope,
    confirmedAt: value.confirmedAt,
    expiresAt: value.expiresAt,
    note: value.note,
    confirmedBy: value.confirmedBy,
    confirmedByEmail: value.confirmedByEmail,
    updatedAt: value.updatedAt,
  };
}

async function replayMutation(
  db: D1Database,
  tenantId: string,
  idempotencyKey: string,
  action: string,
  requestHash: string,
) {
  const row = await db.prepare(`
    SELECT entity_id, action, after_json FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<{
    entity_id: string;
    action: string;
    after_json: string | null;
  }>();
  if (!row) return null;
  const after = parseJsonObject(row.after_json);
  if (row.action !== action || after?.requestHash !== requestHash) {
    throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  return { entityId: row.entity_id, after };
}

function auditStatement(db: D1Database, input: {
  user: UserContext;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: string | null;
  afterJson: string | null;
  idempotencyKey: string;
  now: string;
}) {
  return db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)
  `).bind(
    crypto.randomUUID(),
    input.user.tenantId,
    input.user.id,
    input.user.email,
    input.action,
    input.entityType,
    input.entityId,
    input.beforeJson,
    input.afterJson,
    crypto.randomUUID(),
    input.idempotencyKey,
    input.now,
  );
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function hashPayload(input: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function stableInventoryConfirmationId(tenantId: string, skuId: string) {
  const digest = await hashPayload({ tenantId, skuId });
  return `inventory-confirmation:${digest}`;
}

function parseJsonObject(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
