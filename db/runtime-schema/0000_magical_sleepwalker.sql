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
VALUES ('tenant_yicang_demo', '华东事业部', '2026-09-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO warehouses (id, tenant_id, code, name, created_at) VALUES
  ('wh_us_west', 'tenant_yicang_demo', 'US-WEST', '美西仓', '2026-09-01T00:00:00.000Z'),
  ('wh_us_east', 'tenant_yicang_demo', 'US-EAST', '美东仓', '2026-09-01T00:00:00.000Z'),
  ('wh_uk', 'tenant_yicang_demo', 'UK-01', '英国仓', '2026-09-01T00:00:00.000Z'),
  ('wh_de', 'tenant_yicang_demo', 'DE-01', '德国仓', '2026-09-01T00:00:00.000Z'),
  ('wh_ca', 'tenant_yicang_demo', 'CA-01', '加拿大仓', '2026-09-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO skus (id, tenant_id, code, name, active, created_at) VALUES
  ('sku_chair', 'tenant_yicang_demo', 'BF-CH-8821', '北欧实木餐椅 · 胡桃色', 1, '2026-09-01T00:00:00.000Z'),
  ('sku_desk', 'tenant_yicang_demo', 'BF-TB-2046', '可升降电脑桌 120cm', 1, '2026-09-01T00:00:00.000Z'),
  ('sku_sofa', 'tenant_yicang_demo', 'BF-SF-7135', '模块化三人布艺沙发', 1, '2026-09-01T00:00:00.000Z'),
  ('sku_cabinet', 'tenant_yicang_demo', 'BF-CB-1092', '藤编双门储物柜', 1, '2026-09-01T00:00:00.000Z'),
  ('sku_lamp', 'tenant_yicang_demo', 'BF-LT-5520', '极简落地灯 · 米白', 1, '2026-09-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO inventory_balances (
  id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at
) VALUES
  ('inv_chair_usw', 'tenant_yicang_demo', 'sku_chair', 'wh_us_west', 18, 0, 1, '2026-09-01T00:00:00.000Z'),
  ('inv_desk_use', 'tenant_yicang_demo', 'sku_desk', 'wh_us_east', 364, 0, 1, '2026-09-01T00:00:00.000Z'),
  ('inv_sofa_uk', 'tenant_yicang_demo', 'sku_sofa', 'wh_uk', 8, 2, 1, '2026-09-01T00:00:00.000Z'),
  ('inv_cabinet_de', 'tenant_yicang_demo', 'sku_cabinet', 'wh_de', 150, 8, 1, '2026-09-01T00:00:00.000Z'),
  ('inv_lamp_ca', 'tenant_yicang_demo', 'sku_lamp', 'wh_ca', 0, 0, 1, '2026-09-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO orders (
  id, tenant_id, order_no, idempotency_key, request_hash, channel, destination, customer_name,
  currency, amount_minor, status, sku_id, warehouse_id, quantity, version, created_by, updated_by,
  last_action_key, request_id, created_at, updated_at
) VALUES
  ('ord_seed_pending', 'tenant_yicang_demo', 'YC260901-3862', 'seed-order-pending', 'seed', 'Amazon US', '美国', 'Olivia Wilson', 'USD', 17899, 'pending_review', 'sku_chair', 'wh_us_west', 2, 1, 'system', 'system', 'seed-order-pending', 'seed-request-1', '2026-09-01T03:42:00.000Z', '2026-09-01T03:42:00.000Z'),
  ('ord_seed_reserved', 'tenant_yicang_demo', 'YC260901-3859', 'seed-order-reserved', 'seed', 'Shopify', '英国', 'Arthur Hall', 'GBP', 8200, 'reserved', 'sku_sofa', 'wh_uk', 2, 1, 'system', 'system', 'seed-order-reserved', 'seed-request-2', '2026-09-01T03:26:00.000Z', '2026-09-01T03:26:00.000Z'),
  ('ord_seed_picking', 'tenant_yicang_demo', 'YC260901-3851', 'seed-order-picking', 'seed', 'eBay DE', '德国', 'Lena Weber', 'EUR', 25288, 'reserved', 'sku_cabinet', 'wh_de', 8, 1, 'system', 'system', 'seed-order-picking', 'seed-request-3', '2026-09-01T02:58:00.000Z', '2026-09-01T02:58:00.000Z'),
  ('ord_seed_shipped', 'tenant_yicang_demo', 'YC260901-3844', 'seed-order-shipped', 'seed', 'TikTok Shop', '加拿大', 'Emma Brown', 'USD', 8350, 'shipped', 'sku_desk', 'wh_us_east', 1, 1, 'system', 'system', 'seed-order-shipped', 'seed-request-4', '2026-09-01T02:31:00.000Z', '2026-09-01T02:31:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO inventory_movements (
  id, tenant_id, order_id, sku_id, warehouse_id, type, on_hand_delta, reserved_delta, operation_key, created_by, created_at
) VALUES
  ('mov_seed_sofa_reserve', 'tenant_yicang_demo', 'ord_seed_reserved', 'sku_sofa', 'wh_uk', 'reserve', 0, 2, 'ord_seed_reserved:reserve', 'system', '2026-09-01T03:26:00.000Z'),
  ('mov_seed_cabinet_reserve', 'tenant_yicang_demo', 'ord_seed_picking', 'sku_cabinet', 'wh_de', 'reserve', 0, 8, 'ord_seed_picking:reserve', 'system', '2026-09-01T02:58:00.000Z'),
  ('mov_seed_desk_ship', 'tenant_yicang_demo', 'ord_seed_shipped', 'sku_desk', 'wh_us_east', 'ship', -1, -1, 'ord_seed_shipped:ship', 'system', '2026-09-01T02:31:00.000Z');
