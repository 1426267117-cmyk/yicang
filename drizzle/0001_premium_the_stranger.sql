CREATE TABLE `connector_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`connector` text NOT NULL,
	`resource` text NOT NULL,
	`mode` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`starting_cursor` text,
	`ending_cursor` text,
	`status` text NOT NULL,
	`pages_completed` integer DEFAULT 0 NOT NULL,
	`orders_seen` integer DEFAULT 0 NOT NULL,
	`orders_inserted` integer DEFAULT 0 NOT NULL,
	`orders_updated` integer DEFAULT 0 NOT NULL,
	`orders_unchanged` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_connector_sync_runs_store` ON `connector_sync_runs` (`platform_store_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_connector_sync_runs_status` ON `connector_sync_runs` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `connector_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`connector` text NOT NULL,
	`resource` text NOT NULL,
	`completed_watermark` text,
	`active_window_start` text,
	`active_window_end` text,
	`next_page_cursor` text,
	`overlap_seconds` integer DEFAULT 21600 NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_run_id` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connector_sync_state_resource` ON `connector_sync_state` (`platform_store_id`,`connector`,`resource`);--> statement-breakpoint
CREATE INDEX `idx_connector_sync_state_tenant` ON `connector_sync_state` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `platform_fulfillment_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`fulfillment_id` text NOT NULL,
	`source_fulfillment_line_id` text NOT NULL,
	`source_order_line_id` text,
	`quantity` integer NOT NULL,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fulfillment_id`) REFERENCES `platform_fulfillments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_fulfillment_lines_source` ON `platform_fulfillment_lines` (`fulfillment_id`,`source_fulfillment_line_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_fulfillment_lines_order` ON `platform_fulfillment_lines` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_fulfillment_tracking` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`fulfillment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`company` text,
	`tracking_number` text,
	`tracking_url` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fulfillment_id`) REFERENCES `platform_fulfillments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_tracking_source` ON `platform_fulfillment_tracking` (`fulfillment_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_platform_tracking_order` ON `platform_fulfillment_tracking` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_fulfillments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`source_fulfillment_id` text NOT NULL,
	`status` text,
	`shipment_status` text,
	`source_location_id` text,
	`source_created_at` text,
	`source_updated_at` text,
	`delivered_at` text,
	`estimated_delivery_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_fulfillments_source` ON `platform_fulfillments` (`order_id`,`source_fulfillment_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_fulfillments_order` ON `platform_fulfillments` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`source_order_line_id` text NOT NULL,
	`raw_sku` text,
	`normalized_sku` text,
	`source_product_id` text,
	`source_variant_id` text,
	`title` text,
	`name` text,
	`ordered_quantity` integer NOT NULL,
	`current_quantity` integer,
	`unfulfilled_quantity` integer,
	`currency` text,
	`unit_price_amount` text,
	`unit_price_minor` integer,
	`original_total_amount` text,
	`original_total_minor` integer,
	`discounted_total_amount` text,
	`discounted_total_minor` integer,
	`discount_amount` text,
	`discount_minor` integer,
	`mapped_sku_id` text,
	`mapping_status` text DEFAULT 'unmapped' NOT NULL,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mapped_sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_order_lines_source` ON `platform_order_lines` (`order_id`,`source_order_line_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_order_lines_sku` ON `platform_order_lines` (`tenant_id`,`raw_sku`);--> statement-breakpoint
CREATE INDEX `idx_platform_order_lines_order` ON `platform_order_lines` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_order_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`sync_run_id` text,
	`source_updated_at` text NOT NULL,
	`raw_hash` text NOT NULL,
	`raw_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_order_snapshots_hash` ON `platform_order_snapshots` (`order_id`,`raw_hash`);--> statement-breakpoint
CREATE INDEX `idx_platform_order_snapshots_order` ON `platform_order_snapshots` (`order_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `platform_order_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`refund_id` text,
	`source_transaction_id` text NOT NULL,
	`source_parent_transaction_id` text,
	`kind` text,
	`status` text,
	`gateway` text,
	`test` integer,
	`currency` text,
	`amount` text,
	`amount_minor` integer,
	`source_created_at` text,
	`source_processed_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_id`) REFERENCES `platform_refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_transactions_source` ON `platform_order_transactions` (`order_id`,`source_transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_transactions_refund` ON `platform_order_transactions` (`refund_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_transactions_order` ON `platform_order_transactions` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`platform` text NOT NULL,
	`source_order_id` text NOT NULL,
	`source_order_name` text,
	`source_created_at` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`source_processed_at` text,
	`source_cancelled_at` text,
	`source_closed_at` text,
	`source_timezone` text,
	`business_date` text,
	`test` integer,
	`financial_status` text,
	`fulfillment_status` text,
	`currency` text,
	`subtotal_amount` text,
	`subtotal_minor` integer,
	`discount_amount` text,
	`discount_minor` integer,
	`shipping_amount` text,
	`shipping_minor` integer,
	`tax_amount` text,
	`tax_minor` integer,
	`original_total_amount` text,
	`original_total_minor` integer,
	`current_total_amount` text,
	`current_total_minor` integer,
	`received_amount` text,
	`received_minor` integer,
	`refunded_amount` text,
	`refunded_minor` integer,
	`business_ownership` text,
	`api_version` text NOT NULL,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`fetched_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_orders_source` ON `platform_orders` (`tenant_id`,`platform_store_id`,`source_order_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_orders_updated` ON `platform_orders` (`platform_store_id`,`source_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_orders_created` ON `platform_orders` (`platform_store_id`,`source_created_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_orders_status` ON `platform_orders` (`platform_store_id`,`financial_status`,`fulfillment_status`);--> statement-breakpoint
CREATE TABLE `platform_refund_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`refund_id` text NOT NULL,
	`source_refund_line_id` text NOT NULL,
	`source_order_line_id` text,
	`quantity` integer NOT NULL,
	`restock_type` text,
	`source_location_id` text,
	`currency` text,
	`subtotal_amount` text,
	`subtotal_minor` integer,
	`tax_amount` text,
	`tax_minor` integer,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_id`) REFERENCES `platform_refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_refund_lines_source` ON `platform_refund_lines` (`refund_id`,`source_refund_line_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_refund_lines_order` ON `platform_refund_lines` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`source_refund_id` text NOT NULL,
	`source_created_at` text,
	`source_updated_at` text,
	`note` text,
	`currency` text,
	`amount` text,
	`amount_minor` integer,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_refunds_source` ON `platform_refunds` (`order_id`,`source_refund_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_refunds_order` ON `platform_refunds` (`order_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `platform_sku_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`raw_sku` text NOT NULL,
	`normalized_sku` text NOT NULL,
	`sku_id` text,
	`status` text NOT NULL,
	`mapping_source` text NOT NULL,
	`rule_version` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_sku_mappings_source` ON `platform_sku_mappings` (`platform_store_id`,`raw_sku`);--> statement-breakpoint
CREATE INDEX `idx_platform_sku_mappings_sku` ON `platform_sku_mappings` (`tenant_id`,`sku_id`);--> statement-breakpoint
CREATE TABLE `platform_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform` text NOT NULL,
	`connector_key` text NOT NULL,
	`display_name` text NOT NULL,
	`official_store_id` text NOT NULL,
	`source_domain` text,
	`source_timezone` text,
	`source_timezone_offset` text,
	`currency` text,
	`api_version` text NOT NULL,
	`credential_ref` text NOT NULL,
	`identity_verified_at` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_successful_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_stores_official` ON `platform_stores` (`tenant_id`,`platform`,`official_store_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_stores_connector` ON `platform_stores` (`tenant_id`,`platform`,`connector_key`);--> statement-breakpoint
CREATE INDEX `idx_platform_stores_tenant` ON `platform_stores` (`tenant_id`,`platform`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_validate_transition`
BEFORE UPDATE OF `status` ON `orders`
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending_review' AND NEW.status IN ('reserved', 'cancelled')) OR
  (OLD.status = 'reserved' AND NEW.status IN ('shipped', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORDER_TRANSITION');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_check_stock`
BEFORE UPDATE OF `status` ON `orders`
WHEN OLD.status = 'pending_review' AND NEW.status = 'reserved'
BEGIN
  SELECT CASE WHEN COALESCE((
    SELECT on_hand_qty - reserved_qty
    FROM inventory_balances
    WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id
  ), 0) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_reserve_stock`
AFTER UPDATE OF `status` ON `orders`
WHEN OLD.status = 'pending_review' AND NEW.status = 'reserved'
BEGIN
  UPDATE inventory_balances
  SET reserved_qty = reserved_qty + NEW.quantity,
      version = version + 1,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id;
  INSERT INTO inventory_movements (
    id, tenant_id, order_id, sku_id, warehouse_id, type,
    on_hand_delta, reserved_delta, operation_key, created_by, created_at
  ) VALUES (
    lower(hex(randomblob(16))), NEW.tenant_id, NEW.id, NEW.sku_id, NEW.warehouse_id, 'reserve',
    0, NEW.quantity, NEW.id || ':reserve', NEW.updated_by, NEW.updated_at
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_ship_stock`
AFTER UPDATE OF `status` ON `orders`
WHEN OLD.status = 'reserved' AND NEW.status = 'shipped'
BEGIN
  UPDATE inventory_balances
  SET on_hand_qty = on_hand_qty - NEW.quantity,
      reserved_qty = reserved_qty - NEW.quantity,
      version = version + 1,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id;
  INSERT INTO inventory_movements (
    id, tenant_id, order_id, sku_id, warehouse_id, type,
    on_hand_delta, reserved_delta, operation_key, created_by, created_at
  ) VALUES (
    lower(hex(randomblob(16))), NEW.tenant_id, NEW.id, NEW.sku_id, NEW.warehouse_id, 'ship',
    -NEW.quantity, -NEW.quantity, NEW.id || ':ship', NEW.updated_by, NEW.updated_at
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_release_stock`
AFTER UPDATE OF `status` ON `orders`
WHEN OLD.status = 'reserved' AND NEW.status = 'cancelled'
BEGIN
  UPDATE inventory_balances
  SET reserved_qty = reserved_qty - NEW.quantity,
      version = version + 1,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id;
  INSERT INTO inventory_movements (
    id, tenant_id, order_id, sku_id, warehouse_id, type,
    on_hand_delta, reserved_delta, operation_key, created_by, created_at
  ) VALUES (
    lower(hex(randomblob(16))), NEW.tenant_id, NEW.id, NEW.sku_id, NEW.warehouse_id, 'release',
    0, -NEW.quantity, NEW.id || ':release', NEW.updated_by, NEW.updated_at
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_audit_insert`
AFTER INSERT ON `orders`
BEGIN
  INSERT INTO audit_logs (
    id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
    before_json, after_json, request_id, idempotency_key, source, created_at
  ) VALUES (
    lower(hex(randomblob(16))), NEW.tenant_id, NEW.created_by,
    COALESCE((SELECT email FROM members WHERE auth_user_id = NEW.created_by), 'system'),
    'CREATE_ORDER', 'order', NEW.id, NULL,
    json_object('orderNo', NEW.order_no, 'status', NEW.status, 'quantity', NEW.quantity),
    NEW.request_id, NEW.idempotency_key, 'human', NEW.created_at
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_audit_status`
AFTER UPDATE OF `status` ON `orders`
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO audit_logs (
    id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
    before_json, after_json, request_id, idempotency_key, source, created_at
  ) VALUES (
    lower(hex(randomblob(16))), NEW.tenant_id, NEW.updated_by,
    COALESCE((SELECT email FROM members WHERE auth_user_id = NEW.updated_by), 'system'),
    CASE NEW.status WHEN 'reserved' THEN 'APPROVE_ORDER' WHEN 'shipped' THEN 'SHIP_ORDER' ELSE 'CANCEL_ORDER' END,
    'order', NEW.id,
    json_object('status', OLD.status, 'version', OLD.version),
    json_object('status', NEW.status, 'version', NEW.version),
    NEW.request_id, NEW.last_action_key, 'human', NEW.updated_at
  );
END;
