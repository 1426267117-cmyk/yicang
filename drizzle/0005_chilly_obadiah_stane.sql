ALTER TABLE `shopify_webhook_events` ADD `next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `shopify_webhook_events` ADD `lease_id` text;--> statement-breakpoint
ALTER TABLE `shopify_webhook_events` ADD `lease_expires_at` text;--> statement-breakpoint
CREATE INDEX `idx_shopify_webhook_events_ready` ON `shopify_webhook_events` (`status`,`next_attempt_at`,`created_at`);