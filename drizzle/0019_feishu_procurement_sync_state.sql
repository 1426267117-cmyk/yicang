CREATE TABLE `feishu_procurement_sync_state` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`queued` integer DEFAULT false NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_error` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_feishu_procurement_sync_lease" CHECK(("feishu_procurement_sync_state"."lease_id" IS NULL) = ("feishu_procurement_sync_state"."lease_expires_at" IS NULL))
);
