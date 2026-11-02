CREATE TABLE `sku_inventory_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`confirmed_available_qty` integer NOT NULL,
	`scope` text DEFAULT 'all_warehouses' NOT NULL,
	`confirmed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`note` text NOT NULL,
	`confirmed_by` text NOT NULL,
	`confirmed_by_email` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_sku_inventory_confirmation_non_negative" CHECK("sku_inventory_confirmations"."confirmed_available_qty" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sku_inventory_confirmations` ON `sku_inventory_confirmations` (`tenant_id`,`sku_id`);--> statement-breakpoint
CREATE INDEX `idx_sku_inventory_confirmations_expiry` ON `sku_inventory_confirmations` (`tenant_id`,`expires_at`);