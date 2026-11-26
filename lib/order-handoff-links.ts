import type { OrderStatus } from './domain';

export type StoredHandoffLink = {
  order_id: string; order_no: string; status: OrderStatus; tracked_packages: number;
  source_order_no: string; source_sku: string; source_observed_at: string; request_hash: string;
  platform_order_id: string | null;
};

export function findHandoffLinks(db: D1Database, tenantId: string, storeKey: string, orderKeys: string[], nativeOrderId?: string) {
  return db.prepare(`
    SELECT link.order_id, o.order_no, o.status, link.source_order_no, link.source_sku,
      link.source_observed_at, link.request_hash, proof.platform_order_id,
      (SELECT COUNT(DISTINCT package_id) FROM logistics_tracking_events t
        WHERE t.tenant_id = link.tenant_id AND t.order_id = link.order_id) AS tracked_packages
    FROM nine_store_order_handoffs link
    JOIN orders o ON o.id = link.order_id AND o.tenant_id = link.tenant_id
    LEFT JOIN native_channel_handoff_proofs proof ON proof.order_id = o.id AND proof.tenant_id = o.tenant_id
    WHERE link.tenant_id = ? AND link.store_key = ?
      AND (link.source_order_key IN (${orderKeys.map(() => '?').join(', ')}) OR proof.platform_order_id = ?)
    LIMIT 2
  `).bind(tenantId, storeKey, ...orderKeys, nativeOrderId ?? null).all<StoredHandoffLink>();
}

export function linkedOrderSummary(link: StoredHandoffLink) {
  return { id: link.order_id, orderNo: link.order_no, status: link.status, trackedPackages: Number(link.tracked_packages) };
}

export async function findFeishuNativeIdentity(db: D1Database, tenantId: string, storeKey: string, orderKey: string) {
  if (!storeKey.startsWith('shopify-')) return { keys: [orderKey], nativeOrderId: undefined, uncertain: false };
  const { results } = await db.prepare(`
    SELECT i.id, i.order_key, i.alternate_order_key, i.internal_order_no, EXISTS (
      SELECT 1 FROM platform_stores other
      WHERE other.tenant_id = i.tenant_id AND other.platform = i.platform AND other.id <> i.platform_store_id
        AND other.connector_key IN (i.store_key, substr(i.store_key, 9))
    ) AS ambiguous_store
    FROM native_channel_order_identity i
    WHERE i.tenant_id = ? AND i.store_key = ?
      AND ? IN (i.order_key, i.alternate_order_key, i.internal_order_no, '#' || i.internal_order_no)
    LIMIT 2
  `).bind(tenantId, storeKey, orderKey).all<{ id: string; order_key: string; alternate_order_key: string | null; ambiguous_store: number }>();
  const source = results[0];
  if (!source) return { keys: [orderKey], nativeOrderId: undefined, uncertain: false };
  if (results.length !== 1 || source.ambiguous_store || (source.order_key !== orderKey && source.alternate_order_key !== orderKey)) {
    return { keys: [orderKey], nativeOrderId: undefined, uncertain: true };
  }
  return { keys: [source.order_key, ...(source.alternate_order_key ? [source.alternate_order_key] : [])], nativeOrderId: source.id, uncertain: false };
}
