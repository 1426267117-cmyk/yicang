CREATE TABLE `native_channel_handoff_proofs` (
	`order_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`official_store_id` text NOT NULL,
	`platform_order_id` text NOT NULL,
	`platform_line_id` text NOT NULL,
	`source_version` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_line_id`) REFERENCES `platform_order_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_native_channel_handoff_order` ON `native_channel_handoff_proofs` (`tenant_id`,`platform_order_id`);
--> statement-breakpoint
CREATE VIEW native_channel_order_identity AS
WITH orders_with_identity AS (
  SELECT o.id, o.tenant_id, o.platform, o.platform_store_id, s.official_store_id, s.active AS store_active,
    s.identity_verified_at,
    CASE
      WHEN o.platform = 'amazon' AND s.connector_key IN ('amazon-senyu', 'amazon-kaguyasu', 'amazon-zhongcheng', 'amazon-genji') THEN s.connector_key
      WHEN o.platform = 'shopify' AND s.connector_key IN ('zimasya', 'kaguyasu', 'anzhap', 'bizfurniz') THEN 'shopify-' || s.connector_key
      WHEN o.platform = 'shopify' AND s.connector_key IN ('shopify-zimasya', 'shopify-kaguyasu', 'shopify-anzhap', 'shopify-bizfurniz') THEN s.connector_key
    END AS store_key,
    CASE WHEN o.platform = 'amazon' THEN o.source_order_id ELSE NULLIF(trim(o.source_order_name), '') END AS order_no,
    CASE WHEN o.platform = 'shopify' AND substr(o.source_order_id, 1, 20) = 'gid://shopify/Order/'
      AND length(o.source_order_id) > 20 AND substr(o.source_order_id, 21) NOT GLOB '*[^0-9]*'
      THEN substr(o.source_order_id, 21) END AS internal_order_no
  FROM platform_orders o
  JOIN platform_stores s ON s.id = o.platform_store_id AND s.tenant_id = o.tenant_id AND s.platform = o.platform
  WHERE o.platform IN ('shopify', 'amazon')
)
SELECT i.*, upper(i.order_no) AS order_key,
  CASE WHEN i.platform = 'shopify' AND i.order_no <> '' AND i.order_no NOT GLOB '*[^0-9]*' THEN '#' || i.order_no
    WHEN i.platform = 'shopify' AND substr(i.order_no, 1, 1) = '#' AND length(i.order_no) > 1
      AND substr(i.order_no, 2) NOT GLOB '*[^0-9]*' THEN substr(i.order_no, 2)
  END AS alternate_order_key
FROM orders_with_identity i;
--> statement-breakpoint
CREATE VIEW native_channel_handoff_candidates AS
SELECT i.*, o.raw_hash AS source_version, o.source_updated_at, o.fetched_at,
  o.currency, o.current_total_minor AS amount_minor, l.id AS platform_line_id, l.raw_hash AS line_version,
  NULLIF(trim(l.raw_sku), '') AS sku,
  COALESCE(NULLIF(trim(l.title), ''), NULLIF(trim(l.name), '')) AS title,
  l.unfulfilled_quantity AS quantity,
  CASE
    WHEN COALESCE(o.test, 0) <> 0 THEN 'test_order'
    WHEN i.store_key IS NULL OR i.store_active <> 1 OR trim(i.official_store_id) = '' OR trim(i.identity_verified_at) = '' THEN 'unverified_store'
    WHEN i.order_key IS NULL OR EXISTS (
      SELECT 1 FROM native_channel_order_identity other
      WHERE other.tenant_id = i.tenant_id AND other.id <> i.id AND other.store_key = i.store_key
        AND (other.order_key IN (i.order_key, i.alternate_order_key)
          OR other.alternate_order_key IN (i.order_key, i.alternate_order_key)
          OR other.order_key IN (i.internal_order_no, '#' || i.internal_order_no)
          OR other.internal_order_no IN (i.order_key, i.alternate_order_key))
    ) OR EXISTS (
      SELECT 1 FROM platform_stores other
      WHERE other.tenant_id = i.tenant_id AND other.platform = 'shopify' AND i.platform = 'shopify'
        AND other.id <> i.platform_store_id AND other.connector_key IN (i.store_key, substr(i.store_key, 9))
    ) THEN 'identity_ambiguous'
    WHEN COALESCE(o.refunded_minor, 0) <> 0 OR o.financial_status IN ('REFUNDED', 'PARTIALLY_REFUNDED') OR EXISTS (
      SELECT 1 FROM platform_refunds r WHERE r.tenant_id = i.tenant_id AND r.order_id = i.id
    ) OR EXISTS (
      SELECT 1 FROM nine_store_order_snapshots snapshot, json_each(snapshot.payload_json, '$.refunds') refund
      WHERE snapshot.tenant_id = i.tenant_id AND json_extract(refund.value, '$.storeKey') = i.store_key
        AND upper(json_extract(refund.value, '$.orderNo')) IN (i.order_key, i.alternate_order_key, i.internal_order_no, '#' || i.internal_order_no)
    ) THEN 'refunded'
    WHEN o.source_cancelled_at IS NOT NULL OR o.source_closed_at IS NOT NULL OR (
      i.platform = 'shopify' AND o.fulfillment_status IS NOT 'UNFULFILLED'
    ) OR (i.platform = 'amazon' AND o.fulfillment_status IS NOT 'UNSHIPPED') OR EXISTS (
      SELECT 1 FROM platform_fulfillments f WHERE f.tenant_id = i.tenant_id AND f.order_id = i.id AND f.is_current = 1
    ) THEN 'not_pending'
    WHEN i.platform = 'shopify' AND (o.financial_status IS NOT 'PAID' OR o.refunded_minor IS NOT 0) THEN 'payment_unverified'
    WHEN i.platform = 'amazon' AND json_extract(CASE WHEN json_valid(o.raw_json) THEN o.raw_json ELSE '{}' END, '$.fulfillment.fulfilledBy') IS NOT 'MERCHANT'
      THEN 'merchant_unverified'
    WHEN l.id IS NULL THEN 'ambiguous_lines'
    WHEN i.platform = 'shopify' AND (
      json_extract(CASE WHEN json_valid(l.raw_json) THEN l.raw_json ELSE '{}' END, '$.requiresShipping') IS NOT 1
      OR json_extract(CASE WHEN json_valid(l.raw_json) THEN l.raw_json ELSE '{}' END, '$.nonFulfillableQuantity') IS NOT 0
    ) THEN 'shipping_unverified'
    WHEN l.unfulfilled_quantity IS NULL OR l.unfulfilled_quantity NOT BETWEEN 1 AND 999
      OR l.unfulfilled_quantity <> l.ordered_quantity
      OR (i.platform = 'shopify' AND l.current_quantity IS NOT l.unfulfilled_quantity)
      OR (i.platform = 'amazon' AND COALESCE(json_extract(CASE WHEN json_valid(l.raw_json) THEN l.raw_json ELSE '{}' END, '$.fulfillment.quantityFulfilled'), 0) <> 0)
      THEN 'quantity_unverified'
    WHEN COALESCE(NULLIF(trim(l.title), ''), NULLIF(trim(l.name), '')) IS NULL THEN 'missing_title'
    WHEN o.current_total_minor IS NULL OR o.current_total_minor NOT BETWEEN 1 AND 100000000
      OR o.currency IS NULL OR o.currency NOT IN ('CNY', 'USD', 'EUR', 'GBP')
      OR (i.platform = 'shopify' AND json_extract(CASE WHEN json_valid(o.raw_json) THEN o.raw_json ELSE '{}' END, '$.currentTotalPriceSet.shopMoney.currencyCode') IS NOT o.currency)
      OR (i.platform = 'amazon' AND json_extract(CASE WHEN json_valid(o.raw_json) THEN o.raw_json ELSE '{}' END, '$.proceeds.grandTotal.currency') IS NOT o.currency)
      THEN 'amount_unverified'
    WHEN trim(COALESCE(l.raw_sku, '')) = '' THEN 'awaiting_sku'
    ELSE 'ready'
  END AS eligibility
FROM native_channel_order_identity i
JOIN platform_orders o ON o.id = i.id AND o.tenant_id = i.tenant_id
LEFT JOIN platform_order_lines l ON l.id = (
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN(line.id) END FROM platform_order_lines line
  WHERE line.tenant_id = i.tenant_id AND line.order_id = i.id AND line.is_current = 1
);
--> statement-breakpoint
CREATE TRIGGER trg_native_channel_handoff_validate
BEFORE INSERT ON native_channel_handoff_proofs
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_CHANNEL_HANDOFF_PROOF_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM native_channel_handoff_candidates source
    JOIN nine_store_order_handoffs link ON link.order_id = NEW.order_id AND link.tenant_id = NEW.tenant_id
    JOIN orders o ON o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id
    WHERE source.id = NEW.platform_order_id AND source.tenant_id = NEW.tenant_id
      AND source.eligibility = 'ready' AND source.platform_store_id = NEW.platform_store_id
      AND source.official_store_id = NEW.official_store_id AND source.platform_line_id = NEW.platform_line_id
      AND source.source_version = NEW.source_version AND source.store_key = link.store_key
      AND source.platform = link.platform AND source.order_key = link.source_order_key
      AND link.source_record_id = 'native:' || source.id AND source.sku = link.source_sku
      AND source.quantity = o.quantity AND source.currency = o.currency AND source.amount_minor = o.amount_minor
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_native_channel_handoff_no_update BEFORE UPDATE ON native_channel_handoff_proofs
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_CHANNEL_HANDOFF_PROOF_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_native_channel_handoff_no_delete BEFORE DELETE ON native_channel_handoff_proofs
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_CHANNEL_HANDOFF_PROOF_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_native_channel_handoff_require_pending_source
BEFORE UPDATE OF status ON orders
WHEN OLD.status <> NEW.status AND NEW.status IN ('reserved', 'shipped') AND EXISTS (
  SELECT 1 FROM native_channel_handoff_proofs WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_CHANNEL_HANDOFF_SOURCE_CHANGED')
  WHERE NOT EXISTS (
    SELECT 1 FROM native_channel_handoff_proofs proof
    JOIN native_channel_handoff_candidates source ON source.id = proof.platform_order_id AND source.tenant_id = proof.tenant_id
    JOIN nine_store_order_handoffs link ON link.order_id = proof.order_id AND link.tenant_id = proof.tenant_id
    JOIN skus s ON s.id = OLD.sku_id AND s.tenant_id = OLD.tenant_id AND s.active = 1
    WHERE proof.tenant_id = OLD.tenant_id AND proof.order_id = OLD.id
      AND source.eligibility = 'ready' AND source.platform_store_id = proof.platform_store_id
      AND source.official_store_id = proof.official_store_id AND source.platform_line_id = proof.platform_line_id
      AND source.store_key = link.store_key AND source.order_key = link.source_order_key
      AND source.sku = link.source_sku AND upper(s.code) = upper(source.sku)
      AND source.quantity = OLD.quantity AND source.currency = OLD.currency AND source.amount_minor = OLD.amount_minor
      AND julianday(source.fetched_at) BETWEEN julianday(NEW.updated_at, '-15 minutes') AND julianday(NEW.updated_at, '+1 minute')
  );
  SELECT RAISE(ABORT, 'WAREHOUSE_PACK_REQUIRED')
  WHERE NEW.status = 'shipped' AND NOT EXISTS (
    SELECT 1 FROM warehouse_outbound_events
    WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id AND version = 3 AND step = 'pack'
  );
END;
--> statement-breakpoint
DROP TRIGGER trg_nine_store_handoff_require_pending_source;
--> statement-breakpoint
CREATE TRIGGER trg_nine_store_handoff_require_pending_source
BEFORE UPDATE OF status ON orders
WHEN OLD.status <> NEW.status AND NEW.status IN ('reserved', 'shipped')
  AND EXISTS (
    SELECT 1 FROM nine_store_order_handoffs WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id
  ) AND NOT EXISTS (
    SELECT 1 FROM native_channel_handoff_proofs WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'NINE_STORE_HANDOFF_SOURCE_CHANGED')
  WHERE NOT EXISTS (
    SELECT 1 FROM nine_store_order_handoffs handoff
    JOIN nine_store_order_snapshots snapshot ON snapshot.tenant_id = handoff.tenant_id
    WHERE handoff.tenant_id = OLD.tenant_id AND handoff.order_id = OLD.id
      AND snapshot.observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '-15 minutes')
      AND snapshot.observed_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '+1 minute')
      AND 1 = (
        SELECT COUNT(*) FROM json_each(snapshot.payload_json, '$.orders') source
        WHERE json_extract(source.value, '$.storeKey') = handoff.store_key
          AND upper(json_extract(source.value, '$.orderNo')) = handoff.source_order_key
      )
      AND EXISTS (
        SELECT 1 FROM json_each(snapshot.payload_json, '$.orders') source
        WHERE json_extract(source.value, '$.storeKey') = handoff.store_key
          AND upper(json_extract(source.value, '$.orderNo')) = handoff.source_order_key
          AND json_extract(source.value, '$.recordId') = handoff.source_record_id
          AND upper(json_extract(source.value, '$.sku')) = upper(handoff.source_sku)
          AND json_extract(source.value, '$.fulfillment') = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(snapshot.payload_json, '$.refunds') refund
        WHERE json_extract(refund.value, '$.storeKey') = handoff.store_key
          AND upper(json_extract(refund.value, '$.orderNo')) = handoff.source_order_key
      )
  );
  SELECT RAISE(ABORT, 'WAREHOUSE_PACK_REQUIRED')
  WHERE NEW.status = 'shipped' AND NOT EXISTS (
    SELECT 1 FROM warehouse_outbound_events
    WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id AND version = 3 AND step = 'pack'
  );
END;
