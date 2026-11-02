CREATE TABLE `shopify_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_key` text NOT NULL,
	`webhook_id` text NOT NULL,
	`topic` text NOT NULL,
	`shop_domain` text NOT NULL,
	`source_order_id` text,
	`api_version` text,
	`triggered_at` text,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shopify_webhook_events_delivery` ON `shopify_webhook_events` (`tenant_id`,`store_key`,`webhook_id`);--> statement-breakpoint
CREATE INDEX `idx_shopify_webhook_events_pending` ON `shopify_webhook_events` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shopify_webhook_events_order` ON `shopify_webhook_events` (`tenant_id`,`store_key`,`source_order_id`);