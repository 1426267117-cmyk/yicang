CREATE TABLE `connector_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform` text NOT NULL,
	`store_key` text NOT NULL,
	`shop_domain` text NOT NULL,
	`official_store_id` text NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text,
	`granted_scopes` text NOT NULL,
	`access_token_expires_at` text,
	`refresh_token_expires_at` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connector_credentials_store` ON `connector_credentials` (`tenant_id`,`platform`,`store_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connector_credentials_identity` ON `connector_credentials` (`tenant_id`,`platform`,`official_store_id`);--> statement-breakpoint
CREATE INDEX `idx_connector_credentials_tenant` ON `connector_credentials` (`tenant_id`,`platform`);