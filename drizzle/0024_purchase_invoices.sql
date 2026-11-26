CREATE TABLE `purchase_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`invoice_on` text NOT NULL,
	`reference` text NOT NULL,
	`note` text,
	`original_invoice_id` text,
	`created_by_member_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_invoice_id`) REFERENCES `purchase_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_invoices_amount" CHECK("purchase_invoices"."amount_minor" > 0),
	CONSTRAINT "ck_purchase_invoices_currency" CHECK("purchase_invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "ck_purchase_invoices_kind" CHECK(("purchase_invoices"."kind" = 'invoice' AND "purchase_invoices"."original_invoice_id" IS NULL) OR ("purchase_invoices"."kind" = 'reversal' AND "purchase_invoices"."original_invoice_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_invoices_idempotency` ON `purchase_invoices` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_purchase_invoices_order` ON `purchase_invoices` (`tenant_id`,`purchase_order_id`,`invoice_on`);--> statement-breakpoint
CREATE INDEX `idx_purchase_invoices_original` ON `purchase_invoices` (`tenant_id`,`original_invoice_id`);