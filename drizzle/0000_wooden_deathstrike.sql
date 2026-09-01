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
CREATE UNIQUE INDEX IF NOT EXISTS `uq_warehouses_tenant_code` ON `warehouses` (`tenant_id`,`code`);
