CREATE TABLE `nine_store_order_snapshots` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_nine_store_order_snapshot_json" CHECK(json_valid("nine_store_order_snapshots"."payload_json") = 1)
);
