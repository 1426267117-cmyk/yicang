CREATE TABLE `purchase_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`paid_at` text NOT NULL,
	`reference` text NOT NULL,
	`note` text,
	`original_payment_id` text,
	`created_by_member_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_payment_id`) REFERENCES `purchase_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_payments_amount" CHECK("purchase_payments"."amount_minor" > 0),
	CONSTRAINT "ck_purchase_payments_currency" CHECK("purchase_payments"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "ck_purchase_payments_kind" CHECK(("purchase_payments"."kind" = 'payment' AND "purchase_payments"."original_payment_id" IS NULL) OR ("purchase_payments"."kind" = 'reversal' AND "purchase_payments"."original_payment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_payments_idempotency` ON `purchase_payments` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_purchase_payments_order` ON `purchase_payments` (`tenant_id`,`purchase_order_id`,`paid_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_payments_original` ON `purchase_payments` (`tenant_id`,`original_payment_id`);