CREATE TABLE `purchase_supplier_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`currency` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_through` text,
	`tiers_json` text NOT NULL,
	`reference` text,
	`note` text,
	`created_by_member_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_supplier_quotes_version" CHECK("purchase_supplier_quotes"."version" > 0),
	CONSTRAINT "ck_supplier_quotes_status" CHECK("purchase_supplier_quotes"."status" IN ('active', 'archived')),
	CONSTRAINT "ck_supplier_quotes_currency" CHECK("purchase_supplier_quotes"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "ck_supplier_quotes_validity" CHECK("purchase_supplier_quotes"."valid_through" IS NULL OR "purchase_supplier_quotes"."valid_through" >= "purchase_supplier_quotes"."valid_from"),
	CONSTRAINT "ck_supplier_quotes_tiers" CHECK(json_valid("purchase_supplier_quotes"."tiers_json") AND json_type("purchase_supplier_quotes"."tiers_json") = 'array' AND json_array_length("purchase_supplier_quotes"."tiers_json") BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supplier_quotes_version` ON `purchase_supplier_quotes` (`tenant_id`,`sku_id`,`supplier_id`,`currency`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supplier_quotes_idempotency` ON `purchase_supplier_quotes` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_supplier_quotes_sku` ON `purchase_supplier_quotes` (`tenant_id`,`sku_id`,`supplier_id`,`currency`,`version`);