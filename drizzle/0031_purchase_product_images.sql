CREATE TABLE `purchase_product_images` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`content_type` text NOT NULL,
	`content` blob NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
