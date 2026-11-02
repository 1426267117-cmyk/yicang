CREATE TABLE `muku_sku_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`muku_sku` text NOT NULL,
	`normalized_muku_sku` text NOT NULL,
	`sku_id` text NOT NULL,
	`mapping_source` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_sku_mappings_source` ON `muku_sku_mappings` (`tenant_id`,`muku_sku`);--> statement-breakpoint
CREATE INDEX `idx_muku_sku_mappings_normalized` ON `muku_sku_mappings` (`tenant_id`,`normalized_muku_sku`);--> statement-breakpoint
CREATE INDEX `idx_muku_sku_mappings_target` ON `muku_sku_mappings` (`tenant_id`,`sku_id`);--> statement-breakpoint
CREATE TABLE `sku_procurement_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`safety_days` integer DEFAULT 14 NOT NULL,
	`safety_stock_qty` integer,
	`moq` integer,
	`pack_size` integer,
	`lead_time_days` integer,
	`preferred_supplier_id` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`preferred_supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_sku_procurement_safety_days" CHECK("sku_procurement_policies"."safety_days" >= 0 AND "sku_procurement_policies"."safety_days" <= 365),
	CONSTRAINT "ck_sku_procurement_safety_stock" CHECK("sku_procurement_policies"."safety_stock_qty" IS NULL OR "sku_procurement_policies"."safety_stock_qty" >= 0),
	CONSTRAINT "ck_sku_procurement_moq" CHECK("sku_procurement_policies"."moq" IS NULL OR "sku_procurement_policies"."moq" > 0),
	CONSTRAINT "ck_sku_procurement_pack_size" CHECK("sku_procurement_policies"."pack_size" IS NULL OR "sku_procurement_policies"."pack_size" > 0),
	CONSTRAINT "ck_sku_procurement_lead_time" CHECK("sku_procurement_policies"."lead_time_days" IS NULL OR "sku_procurement_policies"."lead_time_days" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sku_procurement_policies` ON `sku_procurement_policies` (`tenant_id`,`sku_id`);--> statement-breakpoint
CREATE INDEX `idx_sku_procurement_policies_supplier` ON `sku_procurement_policies` (`tenant_id`,`preferred_supplier_id`);