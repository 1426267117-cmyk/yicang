CREATE TABLE IF NOT EXISTS `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`request_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_audit_tenant_idempotency` ON `audit_logs` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_tenant_created` ON `audit_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inventory_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`on_hand_qty` integer NOT NULL,
	`reserved_qty` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_inventory_non_negative" CHECK("inventory_balances"."on_hand_qty" >= 0 AND "inventory_balances"."reserved_qty" >= 0),
	CONSTRAINT "ck_inventory_reserved_lte_on_hand" CHECK("inventory_balances"."reserved_qty" <= "inventory_balances"."on_hand_qty")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_inventory_tenant_sku_warehouse` ON `inventory_balances` (`tenant_id`,`sku_id`,`warehouse_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inventory_tenant_updated` ON `inventory_balances` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`type` text NOT NULL,
	`on_hand_delta` integer NOT NULL,
	`reserved_delta` integer NOT NULL,
	`operation_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_movements_tenant_operation` ON `inventory_movements` (`tenant_id`,`operation_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_movements_tenant_order` ON `inventory_movements` (`tenant_id`,`order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`auth_user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_members_auth_user` ON `members` (`auth_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_members_tenant` ON `members` (`tenant_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_no` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`customer_name` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`last_action_key` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_orders_amount_positive" CHECK("orders"."amount_minor" > 0),
	CONSTRAINT "ck_orders_quantity_positive" CHECK("orders"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_orders_tenant_order_no` ON `orders` (`tenant_id`,`order_no`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_orders_tenant_idempotency` ON `orders` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orders_tenant_created` ON `orders` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orders_tenant_status` ON `orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skus` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_skus_tenant_code` ON `skus` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `warehouses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_warehouses_tenant_code` ON `warehouses` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_validate_transition`
BEFORE UPDATE OF `status` ON `orders`
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending_review' AND NEW.status IN ('reserved', 'cancelled')) OR
  (OLD.status = 'reserved' AND NEW.status IN ('shipped', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORDER_TRANSITION');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_check_stock`
BEFORE UPDATE OF `status` ON `orders`
WHEN OLD.status = 'pending_review' AND NEW.status = 'reserved'
BEGIN
  SELECT CASE WHEN COALESCE((
    SELECT on_hand_qty - reserved_qty
    FROM inventory_balances
    WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id
  ), 0) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;--> statement-breakpoint
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('tenant_yicang_primary', '易仓 ERP 工作区', '2026-09-01T00:00:00.000Z');
