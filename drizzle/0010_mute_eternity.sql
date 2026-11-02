CREATE TABLE `muku_dataset_state` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`dataset` text NOT NULL,
	`active_snapshot_id` text,
	`status` text NOT NULL,
	`api_version` text,
	`generated_at` text,
	`source` text,
	`grain` text,
	`business_timezone` text,
	`refresh_cadence` text,
	`zero_semantics` text,
	`record_count` integer,
	`page_count` integer,
	`last_run_id` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_dataset_state` ON `muku_dataset_state` (`tenant_id`,`dataset`);--> statement-breakpoint
CREATE INDEX `idx_muku_dataset_state_status` ON `muku_dataset_state` (`tenant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `muku_inventory_detail_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`record_key` text,
	`source_id` text,
	`source_snapshot_id` text,
	`source_kind` text,
	`warehouse_code` text,
	`warehouse_name` text,
	`region` text,
	`sku` text,
	`cabinet_no` text,
	`received_at` text,
	`note` text,
	`stock_status` text,
	`package_barcode` text,
	`product_dimensions` text,
	`package_dimensions` text,
	`product_color_style` text,
	`packaging_type` text,
	`reserved_order_no` text,
	`inbound_batch` text,
	`sequence_no` text,
	`parent_spu` text,
	`parent_record` text,
	`category` text,
	`estimated_arrival_at` text,
	`age_days` integer,
	`quantity` integer,
	`stock_unit_qty` integer,
	`source_updated_at` text,
	`ingested_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_inventory_detail_snapshot_key` ON `muku_inventory_detail_records` (`snapshot_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `idx_muku_inventory_detail_lookup` ON `muku_inventory_detail_records` (`tenant_id`,`snapshot_id`,`sku`,`warehouse_code`);--> statement-breakpoint
CREATE TABLE `muku_inventory_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`record_key` text,
	`source_id` text,
	`source_snapshot_id` text,
	`inventory_kind` text,
	`warehouse_code` text,
	`warehouse_name` text,
	`region` text,
	`sku` text,
	`available_qty` integer,
	`locked_qty` integer,
	`on_hand_qty` integer,
	`inbound_qty` integer,
	`age_days` integer,
	`source_updated_at` text,
	`ingested_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_inventory_snapshot_key` ON `muku_inventory_records` (`snapshot_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `idx_muku_inventory_lookup` ON `muku_inventory_records` (`tenant_id`,`snapshot_id`,`sku`,`warehouse_code`);--> statement-breakpoint
CREATE TABLE `muku_inventory_risk_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`sku` text,
	`sales_30d` integer,
	`available_qty` integer,
	`locked_qty` integer,
	`on_hand_qty` integer,
	`inbound_qty` integer,
	`warehouse_count` integer,
	`max_age_days` integer,
	`slow_moving` integer,
	`over_age` integer,
	`active_low_stock` integer,
	`matched_by` text,
	`source_updated_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_inventory_risk_snapshot_key` ON `muku_inventory_risk_records` (`snapshot_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `idx_muku_inventory_risk_lookup` ON `muku_inventory_risk_records` (`tenant_id`,`snapshot_id`,`sku`);--> statement-breakpoint
CREATE TABLE `muku_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`dataset` text NOT NULL,
	`status` text NOT NULL,
	`api_version` text NOT NULL,
	`generated_at` text NOT NULL,
	`source` text,
	`grain` text,
	`business_timezone` text,
	`refresh_cadence` text,
	`zero_semantics` text,
	`filters_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`page_count` integer NOT NULL,
	`record_count` integer NOT NULL,
	`expected_total` integer,
	`source_updated_at` text,
	`ingested_at` text NOT NULL,
	`activated_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_muku_snapshots_content` ON `muku_snapshots` (`tenant_id`,`dataset`,`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_muku_snapshots_dataset` ON `muku_snapshots` (`tenant_id`,`dataset`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `muku_source_status_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`source_kind` text,
	`source_id` text,
	`status` text,
	`business_date` text,
	`message` text,
	`record_count` integer,
	`source_updated_at` text,
	`ingested_at` text,
	`raw_json` text NOT NULL,
	`raw_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_source_status_snapshot_key` ON `muku_source_status_records` (`snapshot_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `idx_muku_source_status_lookup` ON `muku_source_status_records` (`tenant_id`,`snapshot_id`,`source_kind`,`source_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `muku_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`dataset` text NOT NULL,
	`snapshot_id` text,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`lease_id` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`error_code` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `muku_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_sync_runs_idempotency` ON `muku_sync_runs` (`tenant_id`,`dataset`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_muku_sync_runs_running` ON `muku_sync_runs` (`tenant_id`,`dataset`) WHERE "muku_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `idx_muku_sync_runs_dataset` ON `muku_sync_runs` (`tenant_id`,`dataset`,`started_at`);
