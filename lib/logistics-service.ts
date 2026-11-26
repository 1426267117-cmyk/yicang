import { HttpError, requirePermission, type UserContext } from './db';
import { canManageWarehouseFulfillment, canReadWarehouseFulfillment } from './domain';
import { feishuProcurementPreviewSchema } from './feishu-procurement-preview-contract';
import {
  logisticsPageSize,
  type LogisticsHistoryRow,
  type LogisticsStatus,
  type ManualLogisticsRow,
  type PlatformLogisticsRow,
  type TrackingEventInput,
} from './logistics-contracts';

const latestTracking = `
  SELECT e.* FROM logistics_tracking_events e
  WHERE e.tenant_id = ?
    AND e.version = (SELECT MAX(n.version) FROM logistics_tracking_events n
      WHERE n.tenant_id = e.tenant_id AND n.package_id = e.package_id)
`;

function requireManualLogisticsRead(user: UserContext) {
  if (!canReadWarehouseFulfillment(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权查看 ERP 发货运单', 'PERMISSION_DENIED');
  }
}

function pageResult<Row extends object>(results: Array<Row & { total: number }>) {
  let matched = 0;
  const rows = results.map(({ total, ...row }) => {
    matched = total;
    return row;
  });
  return { rows, total: matched };
}

export async function listManualLogistics(
  db: D1Database, user: UserContext, query: string, page: number,
  status: LogisticsStatus | 'unregistered' | 'all',
) {
  requireManualLogisticsRead(user);
  const { results } = await db.prepare(`
    WITH latest AS (${latestTracking}), registered AS (
      SELECT order_id, COUNT(*) AS package_count FROM logistics_tracking_events
      WHERE tenant_id = ? AND version = 1 GROUP BY order_id
    )
    SELECT o.id AS orderId, o.order_no AS orderNo, w.name AS warehouseName,
           s.code AS skuCode, o.quantity, o.updated_at AS shippedAt,
           p.package_count AS packedPackageCount, COALESCE(r.package_count, 0) AS registeredPackageCount,
           e.package_id AS packageId, e.version, e.carrier, e.tracking_number AS trackingNumber,
           e.status, e.created_at AS updatedAt, COUNT(*) OVER () AS total
    FROM orders o
    JOIN warehouses w ON w.tenant_id = o.tenant_id AND w.id = o.warehouse_id
    JOIN skus s ON s.tenant_id = o.tenant_id AND s.id = o.sku_id
    LEFT JOIN warehouse_outbound_events p ON p.tenant_id = o.tenant_id AND p.order_id = o.id AND p.version = 3
    LEFT JOIN registered r ON r.order_id = o.id
    LEFT JOIN latest e ON e.tenant_id = o.tenant_id AND e.order_id = o.id AND ? <> 'unregistered'
    WHERE o.tenant_id = ? AND o.status = 'shipped'
      AND (instr(lower(o.order_no), lower(?)) > 0 OR instr(lower(s.code), lower(?)) > 0
        OR instr(lower(w.name), lower(?)) > 0 OR instr(lower(e.tracking_number), lower(?)) > 0
        OR instr(lower(e.carrier), lower(?)) > 0
        OR (? = 'unregistered' AND EXISTS (
          SELECT 1 FROM latest t WHERE t.order_id = o.id
          AND (instr(lower(t.tracking_number), lower(?)) > 0 OR instr(lower(t.carrier), lower(?)) > 0)
        )))
      AND (? = 'all' OR e.status = ? OR (? = 'unregistered'
        AND COALESCE(r.package_count, 0) < COALESCE(p.package_count, 1)))
    ORDER BY COALESCE(e.created_at, o.updated_at) DESC, o.id, e.package_id
    LIMIT ? OFFSET ?
  `).bind(user.tenantId, user.tenantId, status, user.tenantId, query, query, query, query, query, status, query, query,
    status, status, status,
    logisticsPageSize, (page - 1) * logisticsPageSize).all<ManualLogisticsRow & { total: number }>();
  return pageResult(results);
}

export async function listPlatformLogistics(db: D1Database, user: UserContext, query: string, page: number) {
  requirePermission(user, 'connectors:read');
  const { results } = await db.prepare(`
    SELECT COALESCE(t.id, f.id) AS id, COALESCE(o.source_order_name, o.source_order_id) AS orderNo,
           s.display_name AS storeName, t.company AS carrier, t.tracking_number AS trackingNumber,
           COALESCE(NULLIF(f.shipment_status, ''), f.status) AS status,
           f.estimated_delivery_at AS expectedAt, f.delivered_at AS deliveredAt,
           COALESCE(f.source_updated_at, f.last_seen_at) AS updatedAt, COUNT(*) OVER () AS total
    FROM platform_fulfillments f
    JOIN platform_orders o ON o.tenant_id = f.tenant_id AND o.id = f.order_id
    JOIN platform_stores s ON s.tenant_id = o.tenant_id AND s.id = o.platform_store_id
    LEFT JOIN platform_fulfillment_tracking t ON t.tenant_id = f.tenant_id AND t.order_id = o.id
      AND t.fulfillment_id = f.id AND t.is_current = 1
    WHERE f.tenant_id = ? AND f.is_current = 1 AND COALESCE(o.test, 0) = 0
      AND (instr(lower(COALESCE(o.source_order_name, o.source_order_id)), lower(?)) > 0
        OR instr(lower(s.display_name), lower(?)) > 0 OR instr(lower(t.tracking_number), lower(?)) > 0
        OR instr(lower(t.company), lower(?)) > 0)
    ORDER BY COALESCE(f.source_updated_at, f.last_seen_at) DESC, f.id, t.sequence, t.id
    LIMIT ? OFFSET ?
  `).bind(user.tenantId, query, query, query, query, logisticsPageSize, (page - 1) * logisticsPageSize)
    .all<PlatformLogisticsRow & { total: number }>();
  return pageResult(results);
}

export async function listInboundLogistics(db: D1Database, user: UserContext, query: string, page: number) {
  requirePermission(user, 'purchase:read');
  const stored = await db.prepare(`
    SELECT payload_json, imported_at FROM feishu_procurement_previews
    WHERE tenant_id = ? ORDER BY snapshot_date DESC, id DESC LIMIT 1
  `).bind(user.tenantId).first<{ payload_json: string; imported_at: string }>();
  if (!stored) return { rows: [], total: 0, snapshotDate: null, syncedAt: null };
  const snapshot = feishuProcurementPreviewSchema.parse(JSON.parse(stored.payload_json));
  const lowered = query.toLowerCase();
  const matches = snapshot.transit.filter((row) => [row.sku, row.region, row.batch, row.container]
    .some((value) => value?.toLowerCase().includes(lowered)));
  matches.sort((left, right) => left.arrivalDate.localeCompare(right.arrivalDate) || left.sku.localeCompare(right.sku));
  return { rows: matches.slice((page - 1) * logisticsPageSize, page * logisticsPageSize), total: matches.length,
    snapshotDate: snapshot.snapshotDate, syncedAt: stored.imported_at };
}

export async function getTrackingHistory(db: D1Database, user: UserContext, packageId: string) {
  requireManualLogisticsRead(user);
  const { results } = await db.prepare(`
    SELECT e.id, e.version, e.carrier, e.tracking_number AS trackingNumber, e.status, e.note,
           COALESCE(m.display_name, '工作区成员') AS actor, e.created_at AS createdAt
    FROM logistics_tracking_events e
    LEFT JOIN members m ON m.tenant_id = e.tenant_id AND m.auth_user_id = e.created_by
    WHERE e.tenant_id = ? AND e.package_id = ?
    ORDER BY e.version DESC LIMIT 100
  `).bind(user.tenantId, packageId).all<LogisticsHistoryRow>();
  if (!results.length) throw new HttpError(404, '包裹不存在', 'TRACKING_PACKAGE_NOT_FOUND');
  return results;
}

async function trackingReplay(db: D1Database, user: UserContext, key: string, hash: string) {
  const event = await db.prepare(`
    SELECT package_id AS packageId, version, request_hash AS hash FROM logistics_tracking_events
    WHERE tenant_id = ? AND idempotency_key = ?
  `).bind(user.tenantId, key).first<{ packageId: string; version: number; hash: string }>();
  if (!event) return null;
  if (event.hash !== hash) throw new HttpError(409, '本次提交编号已用于另一条记录', 'IDEMPOTENCY_CONFLICT');
  return { packageId: event.packageId, version: event.version, replayed: true };
}

export async function appendTrackingEvent(db: D1Database, user: UserContext, input: TrackingEventInput, key: string) {
  if (!canManageWarehouseFulfillment(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权登记 ERP 发货运单', 'PERMISSION_DENIED');
  }
  if (!/^[a-zA-Z0-9:_-]{12,128}$/u.test(key)) throw new HttpError(400, '缺少有效的提交编号', 'INVALID_IDEMPOTENCY_KEY');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([user.id, input])));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const replay = await trackingReplay(db, user, key, hash);
  if (replay) return replay;

  const order = await db.prepare(`
    SELECT o.status, p.package_count AS packedPackageCount FROM orders o
    LEFT JOIN warehouse_outbound_events p ON p.tenant_id = o.tenant_id AND p.order_id = o.id AND p.version = 3
    WHERE o.tenant_id = ? AND o.id = ?
  `).bind(user.tenantId, input.orderId).first<{ status: string; packedPackageCount: number | null }>();
  if (!order) throw new HttpError(404, '订单不存在', 'TRACKING_ORDER_NOT_FOUND');
  if (order.status !== 'shipped') throw new HttpError(409, '订单完成仓库发货后才可登记运单', 'ORDER_NOT_SHIPPED');

  const packageId = input.packageId ?? crypto.randomUUID();
  if (input.packageId) {
    const current = await db.prepare(`
      SELECT version, status FROM logistics_tracking_events WHERE tenant_id = ? AND order_id = ? AND package_id = ?
      ORDER BY version DESC LIMIT 1
    `).bind(user.tenantId, input.orderId, packageId).first<{ version: number; status: LogisticsStatus }>();
    if (!current) throw new HttpError(404, '当前订单没有这件包裹', 'TRACKING_PACKAGE_NOT_FOUND');
    if (current.version !== input.expectedVersion) {
      const concurrentReplay = await trackingReplay(db, user, key, hash);
      if (concurrentReplay) return concurrentReplay;
      throw new HttpError(409, '包裹记录已更新，请刷新后重试', 'TRACKING_VERSION_CONFLICT');
    }
    if ((current.status === 'delivered' && input.status !== 'delivered')
      || (current.status !== 'registered' && input.status === 'registered')) {
      throw new HttpError(409, '包裹不能退回所选状态', 'INVALID_TRACKING_TRANSITION');
    }
  }

  const version = input.expectedVersion + 1;
  const result = await db.prepare(`
    INSERT INTO logistics_tracking_events
      (id, tenant_id, order_id, package_id, version, carrier, tracking_number, status, note,
       created_by, created_at, idempotency_key, request_hash)
    SELECT ?, o.tenant_id, o.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM orders o
    WHERE o.tenant_id = ? AND o.id = ? AND o.status = 'shipped'
      AND COALESCE((SELECT MAX(v.version) FROM logistics_tracking_events v
        WHERE v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.package_id = ?), 0) = ?
      AND (? > 0 OR ? = 1 OR ? IS NULL OR (
        SELECT COUNT(*) FROM logistics_tracking_events r
        WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id AND r.version = 1
      ) < ?)
      AND NOT EXISTS (
        SELECT 1 FROM logistics_tracking_events e
        WHERE e.tenant_id = o.tenant_id AND e.order_id = o.id AND e.package_id <> ?
          AND lower(e.carrier) = lower(?) AND e.tracking_number = ?
          AND e.version = (SELECT MAX(n.version) FROM logistics_tracking_events n
            WHERE n.tenant_id = e.tenant_id AND n.package_id = e.package_id)
      )
    ON CONFLICT DO NOTHING
  `).bind(crypto.randomUUID(), packageId, version, input.carrier, input.trackingNumber, input.status, input.note || null,
    user.id, new Date().toISOString(), key, hash, user.tenantId, input.orderId, packageId, input.expectedVersion,
    input.expectedVersion, input.additionalPackage ? 1 : 0, order.packedPackageCount, order.packedPackageCount,
    packageId, input.carrier, input.trackingNumber).run();
  if (result.meta.changes === 1) return { packageId, version, replayed: false };

  const concurrentReplay = await trackingReplay(db, user, key, hash);
  if (concurrentReplay) return concurrentReplay;
  if (!input.packageId && !input.additionalPackage && order.packedPackageCount !== null) {
    const registered = await db.prepare(`SELECT COUNT(*) AS count FROM logistics_tracking_events
      WHERE tenant_id = ? AND order_id = ? AND version = 1`).bind(user.tenantId, input.orderId).first<number>('count');
    if (registered !== null && registered >= order.packedPackageCount) {
      throw new HttpError(409, '装箱数量的运单已登记齐全。请刷新后核对，如有额外包裹请说明原因再登记。', 'TRACKING_PACKAGE_LIMIT_REACHED');
    }
  }
  throw new HttpError(409, '运单已登记或包裹记录发生变化，请刷新后重试', 'TRACKING_CONFLICT');
}
