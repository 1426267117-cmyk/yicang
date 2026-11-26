CREATE TABLE `nine_store_order_handoffs` (
	`tenant_id` text NOT NULL,
	`platform` text NOT NULL,
	`store_key` text NOT NULL,
	`source_order_key` text NOT NULL,
	`source_order_no` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_sku` text NOT NULL,
	`source_observed_at` text NOT NULL,
	`order_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `store_key`, `source_order_key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_nine_store_handoff_platform" CHECK("nine_store_order_handoffs"."platform" IN ('amazon', 'shopify', 'wayfair'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_nine_store_handoff_source_record` ON `nine_store_order_handoffs` (`tenant_id`,`platform`,`source_record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_nine_store_handoff_erp_order` ON `nine_store_order_handoffs` (`order_id`);--> statement-breakpoint
CREATE TABLE `nine_store_order_history` (
	`tenant_id` text NOT NULL,
	`source_table` text NOT NULL,
	`source_record_id` text NOT NULL,
	`store_key` text NOT NULL,
	`order_no` text NOT NULL,
	`sku` text,
	`event_date` text,
	`quantity` integer,
	`fulfillment` text,
	`observed_at` text NOT NULL,
	`archived_at` text NOT NULL,
	`change` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `source_table`, `source_record_id`, `observed_at`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_nine_store_history_source" CHECK("nine_store_order_history"."source_table" IN ('amazon-orders', 'shopify-orders', 'wayfair-orders', 'refunds')),
	CONSTRAINT "ck_nine_store_history_change" CHECK("nine_store_order_history"."change" IN ('updated', 'removed')),
	CONSTRAINT "ck_nine_store_history_dates" CHECK("nine_store_order_history"."archived_at" > "nine_store_order_history"."observed_at")
);
--> statement-breakpoint
CREATE INDEX `idx_nine_store_history_archive` ON `nine_store_order_history` (`tenant_id`,`archived_at`,`source_table`);--> statement-breakpoint
CREATE INDEX `idx_nine_store_history_store` ON `nine_store_order_history` (`tenant_id`,`store_key`,`archived_at`);
--> statement-breakpoint
CREATE TRIGGER trg_nine_store_order_history_archive
AFTER UPDATE OF payload_hash ON nine_store_order_snapshots
WHEN OLD.payload_hash <> NEW.payload_hash
BEGIN
  INSERT INTO nine_store_order_history (
    tenant_id, source_table, source_record_id, store_key, order_no, sku, event_date,
    quantity, fulfillment, observed_at, archived_at, change
  )
  SELECT OLD.tenant_id, source_table, source_record_id,
    json_extract(previous, '$.storeKey'), json_extract(previous, '$.orderNo'), json_extract(previous, '$.sku'),
    CASE source_table WHEN 'refunds' THEN json_extract(previous, '$.refundDate') ELSE json_extract(previous, '$.orderDate') END,
    json_extract(previous, '$.quantity'), json_extract(previous, '$.fulfillment'), OLD.observed_at, NEW.observed_at,
    CASE WHEN incoming IS NULL THEN 'removed' ELSE 'updated' END
  FROM (
    SELECT source_table, json_extract(row_json, '$.recordId') AS source_record_id,
      MAX(CASE WHEN is_previous = 1 THEN row_json END) AS previous,
      MAX(CASE WHEN is_previous = 0 THEN row_json END) AS incoming
    FROM (
      SELECT substr(json_extract(value, '$.storeKey'), 1, instr(json_extract(value, '$.storeKey'), '-') - 1) || '-orders' AS source_table,
        value AS row_json, 1 AS is_previous FROM json_each(OLD.payload_json, '$.orders')
      UNION ALL
      SELECT substr(json_extract(value, '$.storeKey'), 1, instr(json_extract(value, '$.storeKey'), '-') - 1) || '-orders',
        value, 0 FROM json_each(NEW.payload_json, '$.orders')
      UNION ALL
      SELECT 'refunds', value, 1 FROM json_each(OLD.payload_json, '$.refunds')
      UNION ALL
      SELECT 'refunds', value, 0 FROM json_each(NEW.payload_json, '$.refunds')
    )
    GROUP BY source_table, source_record_id
  )
  WHERE previous IS NOT NULL AND previous IS NOT incoming;
END;

--> statement-breakpoint
CREATE TRIGGER trg_nine_store_handoff_require_pending_source
BEFORE UPDATE OF status ON orders
WHEN OLD.status <> NEW.status AND NEW.status IN ('reserved', 'shipped')
  AND EXISTS (
    SELECT 1 FROM nine_store_order_handoffs
    WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id
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
