import { sha256Hex, stableId, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';
import type { Permission } from './domain';

export type PurchaseSkuMappingInput = {
  demandId: string;
  skuId?: string;
  newSku?: { code: string; name: string };
};

type MappingTargetRow = {
  id: string;
  platform_store_id: string;
  raw_sku: string | null;
  normalized_sku: string | null;
  mapped_sku_id: string | null;
  status: string;
  required_quantity: number;
  mapping_sku_id: string | null;
  mapping_status: string | null;
};

type SkuRow = {
  id: string;
  code: string;
  name: string;
  active: number;
};

type AuditReceiptRow = {
  action: string;
  entity_id: string;
  after_json: string | null;
};

type MappingReceipt = {
  requestHash: string;
  demandId: string;
  skuId: string;
};

export async function mapPurchaseSku(
  db: D1Database,
  user: UserContext,
  input: PurchaseSkuMappingInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:mapping' as Permission);
  validateIdempotencyKey(idempotencyKey);
  const normalizedInput = normalizeInput(input);
  const requestHash = await sha256Hex(stableJson(normalizedInput));

  const replay = await readReplay(db, user.tenantId, normalizedInput.demandId, requestHash, idempotencyKey);
  if (replay) return { mapping: await getMappingResult(db, user.tenantId, replay.skuId, replay.demandId), replayed: true };

  const target = await getMappingTarget(db, user.tenantId, normalizedInput.demandId);
  const rawSku = target.raw_sku;
  if (!rawSku?.trim()) {
    throw new HttpError(409, '该订单行没有平台 SKU，暂时不能建立统一映射', 'PURCHASE_RAW_SKU_MISSING');
  }
  const sku = await resolveSku(db, user.tenantId, normalizedInput);
  if (target.mapped_sku_id && target.mapped_sku_id !== sku.id) {
    throw new HttpError(409, '该采购需求已映射到其他 ERP SKU', 'PURCHASE_SKU_ALREADY_MAPPED');
  }
  if (target.mapping_status === 'mapped' && target.mapping_sku_id && target.mapping_sku_id !== sku.id) {
    throw new HttpError(409, '该平台 SKU 已映射到其他 ERP SKU', 'PURCHASE_SKU_ALREADY_MAPPED');
  }

  const now = new Date().toISOString();
  const mappingId = await stableId('skumap', user.tenantId, target.platform_store_id, rawSku);
  const auditAfter = stableJson({
    requestHash,
    demandId: target.id,
    skuId: sku.id,
  } satisfies MappingReceipt);
  const auditBefore = stableJson({
    demandId: target.id,
    mappedSkuId: target.mapped_sku_id,
    rawSku,
    status: target.status,
  });
  const statements: D1PreparedStatement[] = [];

  if (sku.create) {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO skus (id, tenant_id, code, name, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).bind(sku.id, user.tenantId, sku.code, sku.name, now));
  }

  statements.push(db.prepare(`
    INSERT INTO platform_sku_mappings (
      id, tenant_id, platform_store_id, raw_sku, normalized_sku, sku_id,
      status, mapping_source, rule_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'mapped', 'manual_purchase_mapping', 'v1', ?, ?)
    ON CONFLICT(platform_store_id, raw_sku) DO UPDATE SET
      normalized_sku = excluded.normalized_sku,
      sku_id = excluded.sku_id,
      status = 'mapped',
      mapping_source = 'manual_purchase_mapping',
      rule_version = 'v1',
      updated_at = excluded.updated_at
    WHERE platform_sku_mappings.tenant_id = excluded.tenant_id
      AND (
        platform_sku_mappings.status <> 'mapped'
        OR platform_sku_mappings.sku_id IS NULL
        OR platform_sku_mappings.sku_id = excluded.sku_id
      )
  `).bind(
    mappingId,
    user.tenantId,
    target.platform_store_id,
    rawSku,
    target.normalized_sku?.trim() || rawSku.trim(),
    sku.id,
    now,
    now,
  ));

  statements.push(db.prepare(`
    UPDATE platform_order_lines
    SET mapped_sku_id = ?, mapping_status = 'mapped'
    WHERE tenant_id = ? AND raw_sku = ?
      AND order_id IN (
        SELECT id FROM platform_orders
        WHERE tenant_id = ? AND platform_store_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM platform_sku_mappings
        WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = ?
          AND status = 'mapped' AND sku_id = ?
      )
  `).bind(
    sku.id,
    user.tenantId,
    rawSku,
    user.tenantId,
    target.platform_store_id,
    user.tenantId,
    target.platform_store_id,
    rawSku,
    sku.id,
  ));

  statements.push(db.prepare(`
    UPDATE purchase_demands
    SET mapped_sku_id = ?,
        status = CASE
          WHEN status = 'needs_mapping' AND required_quantity > 0 THEN 'open'
          ELSE status
        END,
        reason_code = CASE
          WHEN status = 'needs_mapping' AND required_quantity > 0 THEN NULL
          ELSE reason_code
        END,
        last_refreshed_at = ?,
        updated_at = ?
    WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = ?
      AND EXISTS (
        SELECT 1 FROM platform_sku_mappings
        WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = ?
          AND status = 'mapped' AND sku_id = ?
      )
  `).bind(
    sku.id,
    now,
    now,
    user.tenantId,
    target.platform_store_id,
    rawSku,
    user.tenantId,
    target.platform_store_id,
    rawSku,
    sku.id,
  ));

  statements.push(db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    )
    SELECT ?, ?, ?, ?, 'MAP_PURCHASE_SKU', 'purchase_demand', ?, ?, ?, ?, ?, 'human', ?
    WHERE EXISTS (
      SELECT 1 FROM platform_sku_mappings
      WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = ?
        AND status = 'mapped' AND sku_id = ?
    )
  `).bind(
    crypto.randomUUID(),
    user.tenantId,
    user.id,
    user.email,
    target.id,
    auditBefore,
    auditAfter,
    crypto.randomUUID(),
    idempotencyKey,
    now,
    user.tenantId,
    target.platform_store_id,
    rawSku,
    sku.id,
  ));

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentReplay = await readReplay(
      db,
      user.tenantId,
      normalizedInput.demandId,
      requestHash,
      idempotencyKey,
    );
    if (!concurrentReplay) throw error;
    return {
      mapping: await getMappingResult(db, user.tenantId, concurrentReplay.skuId, concurrentReplay.demandId),
      replayed: true,
    };
  }

  const receipt = await readReplay(db, user.tenantId, normalizedInput.demandId, requestHash, idempotencyKey);
  if (!receipt) {
    throw new HttpError(409, '平台 SKU 已被其他操作映射，请刷新后重试', 'PURCHASE_SKU_MAPPING_CONFLICT');
  }
  return {
    mapping: await getMappingResult(db, user.tenantId, receipt.skuId, receipt.demandId),
    replayed: false,
  };
}

async function getMappingTarget(db: D1Database, tenantId: string, demandId: string) {
  const row = await db.prepare(`
    SELECT
      pd.id,
      pd.platform_store_id,
      pd.raw_sku,
      pd.normalized_sku,
      pd.mapped_sku_id,
      pd.status,
      pd.required_quantity,
      pm.sku_id AS mapping_sku_id,
      pm.status AS mapping_status
    FROM purchase_demands pd
    LEFT JOIN platform_sku_mappings pm
      ON pm.tenant_id = pd.tenant_id
      AND pm.platform_store_id = pd.platform_store_id
      AND pm.raw_sku = pd.raw_sku
    WHERE pd.tenant_id = ? AND pd.id = ?
    LIMIT 1
  `).bind(tenantId, demandId).first<MappingTargetRow>();
  if (!row) throw new HttpError(404, '采购需求不存在或不在当前数据范围内', 'PURCHASE_DEMAND_NOT_FOUND');
  return row;
}

async function resolveSku(
  db: D1Database,
  tenantId: string,
  input: ReturnType<typeof normalizeInput>,
) {
  if (input.skuId) {
    const row = await db.prepare(`
      SELECT id, code, name, active FROM skus
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).bind(tenantId, input.skuId).first<SkuRow>();
    if (!row || row.active !== 1) {
      throw new HttpError(404, '所选 ERP SKU 不存在或已停用', 'PURCHASE_SKU_NOT_FOUND');
    }
    return { id: row.id, code: row.code, name: row.name, create: false };
  }

  const code = input.newSku!.code;
  const existing = await db.prepare(`
    SELECT id, code, name, active FROM skus
    WHERE tenant_id = ? AND UPPER(code) = ?
    LIMIT 1
  `).bind(tenantId, code).first<SkuRow>();
  if (existing) {
    if (existing.active !== 1) {
      throw new HttpError(409, '同编码 ERP SKU 已停用，请先恢复后再映射', 'PURCHASE_SKU_INACTIVE');
    }
    return { id: existing.id, code: existing.code, name: existing.name, create: false };
  }
  return {
    id: await stableId('sku', tenantId, code),
    code,
    name: input.newSku!.name,
    create: true,
  };
}

async function readReplay(
  db: D1Database,
  tenantId: string,
  demandId: string,
  requestHash: string,
  idempotencyKey: string,
) {
  const row = await db.prepare(`
    SELECT action, entity_id, after_json
    FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<AuditReceiptRow>();
  if (!row) return null;
  if (row.action !== 'MAP_PURCHASE_SKU' || row.entity_id !== demandId) {
    throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  const receipt = parseReceipt(row.after_json);
  if (!receipt || receipt.requestHash !== requestHash || receipt.demandId !== demandId) {
    throw new HttpError(409, '同一幂等键不能用于不同的 SKU 映射参数', 'IDEMPOTENCY_CONFLICT');
  }
  return receipt;
}

async function getMappingResult(db: D1Database, tenantId: string, skuId: string, demandId: string) {
  const row = await db.prepare(`
    SELECT
      pd.id AS demand_id,
      pd.raw_sku,
      pd.status AS demand_status,
      sku.id AS sku_id,
      sku.code AS sku_code,
      sku.name AS sku_name
    FROM purchase_demands pd
    JOIN skus sku ON sku.id = ? AND sku.tenant_id = pd.tenant_id
    WHERE pd.tenant_id = ? AND pd.id = ?
    LIMIT 1
  `).bind(skuId, tenantId, demandId).first<{
    demand_id: string;
    raw_sku: string | null;
    demand_status: string;
    sku_id: string;
    sku_code: string;
    sku_name: string;
  }>();
  if (!row) throw new HttpError(409, 'SKU 映射结果暂时无法读取', 'PURCHASE_SKU_MAPPING_RESULT_MISSING');
  return {
    demandId: row.demand_id,
    rawSku: row.raw_sku,
    demandStatus: row.demand_status,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
  };
}

function normalizeInput(input: PurchaseSkuMappingInput) {
  return {
    demandId: input.demandId.trim(),
    skuId: input.skuId?.trim() || null,
    newSku: input.newSku
      ? { code: input.newSku.code.trim().toUpperCase(), name: input.newSku.name.trim() }
      : null,
  };
}

function parseReceipt(value: string | null): MappingReceipt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MappingReceipt>;
    return typeof parsed.requestHash === 'string'
      && typeof parsed.demandId === 'string'
      && typeof parsed.skuId === 'string'
      ? parsed as MappingReceipt
      : null;
  } catch {
    return null;
  }
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
