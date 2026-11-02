CREATE TABLE `platform_order_write_leases` (
	`order_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_platform_order_write_leases_expiry` ON `platform_order_write_leases` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_order_write_leases_tenant` ON `platform_order_write_leases` (`tenant_id`);