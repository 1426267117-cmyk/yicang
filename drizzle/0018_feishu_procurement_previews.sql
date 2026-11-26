CREATE TABLE `feishu_procurement_previews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`imported_by` text NOT NULL,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_feishu_procurement_previews_payload_json" CHECK(json_valid("feishu_procurement_previews"."payload_json") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_feishu_procurement_previews_payload` ON `feishu_procurement_previews` (`tenant_id`,`payload_hash`);--> statement-breakpoint
CREATE INDEX `idx_feishu_procurement_previews_latest` ON `feishu_procurement_previews` (`tenant_id`,`snapshot_date`,`id`);