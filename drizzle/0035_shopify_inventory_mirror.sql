CREATE TABLE `shopify_inventory_mirror_entries` (
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`sku` text NOT NULL,
	`status` text NOT NULL,
	`observed_at` text,
	`snapshot_json` text,
	`last_checked_at` text NOT NULL,
	`last_error_code` text,
	PRIMARY KEY(`tenant_id`, `platform_store_id`, `sku`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_shopify_inventory_mirror_entry_status" CHECK("shopify_inventory_mirror_entries"."status" IN ('verified', 'not_found', 'ambiguous', 'untracked', 'unavailable')),
	CONSTRAINT "ck_shopify_inventory_mirror_snapshot" CHECK((
    ("shopify_inventory_mirror_entries"."observed_at" IS NULL AND "shopify_inventory_mirror_entries"."snapshot_json" IS NULL)
    OR ("shopify_inventory_mirror_entries"."observed_at" IS NOT NULL AND "shopify_inventory_mirror_entries"."snapshot_json" IS NOT NULL AND json_valid("shopify_inventory_mirror_entries"."snapshot_json") = 1)
  ))
);
--> statement-breakpoint
CREATE TABLE `shopify_inventory_mirror_state` (
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`cursor_sku` text,
	`status` text NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`last_attempted_at` text NOT NULL,
	`last_completed_at` text,
	`last_error_code` text,
	PRIMARY KEY(`tenant_id`, `platform_store_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_shopify_inventory_mirror_lease" CHECK(("shopify_inventory_mirror_state"."lease_id" IS NULL) = ("shopify_inventory_mirror_state"."lease_expires_at" IS NULL)),
	CONSTRAINT "ck_shopify_inventory_mirror_run_status" CHECK("shopify_inventory_mirror_state"."status" IN ('running', 'complete', 'partial', 'unavailable'))
);
