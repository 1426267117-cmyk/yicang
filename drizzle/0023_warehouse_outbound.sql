CREATE TABLE `warehouse_outbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`version` integer NOT NULL,
	`step` text NOT NULL,
	`quantity` integer,
	`sku_code` text,
	`package_count` integer,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_warehouse_outbound_stage" CHECK(
      ("warehouse_outbound_events"."version" = 1 AND "warehouse_outbound_events"."step" = 'pick' AND typeof("warehouse_outbound_events"."quantity") = 'integer'
        AND "warehouse_outbound_events"."quantity" BETWEEN 1 AND 2147483647 AND "warehouse_outbound_events"."sku_code" IS NULL AND "warehouse_outbound_events"."package_count" IS NULL)
      OR ("warehouse_outbound_events"."version" = 2 AND "warehouse_outbound_events"."step" = 'verify' AND typeof("warehouse_outbound_events"."quantity") = 'integer'
        AND "warehouse_outbound_events"."quantity" BETWEEN 1 AND 2147483647 AND "warehouse_outbound_events"."sku_code" IS NOT NULL
        AND length(trim("warehouse_outbound_events"."sku_code")) BETWEEN 1 AND 160 AND "warehouse_outbound_events"."package_count" IS NULL)
      OR ("warehouse_outbound_events"."version" = 3 AND "warehouse_outbound_events"."step" = 'pack' AND "warehouse_outbound_events"."quantity" IS NULL AND "warehouse_outbound_events"."sku_code" IS NULL
        AND typeof("warehouse_outbound_events"."package_count") = 'integer' AND "warehouse_outbound_events"."package_count" BETWEEN 1 AND 2147483647)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_warehouse_outbound_order_version` ON `warehouse_outbound_events` (`tenant_id`,`order_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_warehouse_outbound_operation` ON `warehouse_outbound_events` (`tenant_id`,`operation_key`);
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_outbound_events_validate
BEFORE INSERT ON warehouse_outbound_events
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_OUTBOUND_ORDER_UNAVAILABLE')
  WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id AND status = 'reserved'
  );

  SELECT RAISE(ABORT, 'WAREHOUSE_OUTBOUND_VERSION_CONFLICT')
  WHERE NEW.version <> 1 + COALESCE((
    SELECT MAX(version) FROM warehouse_outbound_events WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id
  ), 0);

  SELECT RAISE(ABORT, 'WAREHOUSE_OUTBOUND_VALUE_MISMATCH')
  WHERE NEW.step IN ('pick', 'verify') AND NOT EXISTS (
    SELECT 1 FROM orders o
    JOIN skus s ON s.id = o.sku_id AND s.tenant_id = o.tenant_id
    WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id
      AND o.quantity = NEW.quantity AND (NEW.step = 'pick' OR s.code = NEW.sku_code)
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_outbound_events_no_update
BEFORE UPDATE ON warehouse_outbound_events
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_OUTBOUND_EVENT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_outbound_events_no_delete
BEFORE DELETE ON warehouse_outbound_events
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_OUTBOUND_EVENT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_orders_require_warehouse_pack
BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'reserved' AND NEW.status = 'shipped'
  AND EXISTS (
    SELECT 1 FROM warehouse_outbound_events WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id
  ) AND NOT EXISTS (
    SELECT 1 FROM warehouse_outbound_events WHERE tenant_id = OLD.tenant_id AND order_id = OLD.id AND version = 3
  )
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_PACK_REQUIRED');
END;
