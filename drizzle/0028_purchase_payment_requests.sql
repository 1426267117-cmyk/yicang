CREATE TABLE `purchase_payment_request_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`linked_by_member_id` text NOT NULL,
	`linked_at` text NOT NULL,
	`detached_by_member_id` text,
	`detached_at` text,
	`last_operation_key` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `purchase_payment_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `purchase_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`detached_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_payment_request_link_detach" CHECK(("purchase_payment_request_links"."detached_at" IS NULL) = ("purchase_payment_request_links"."detached_by_member_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payment_request_one_active_link` ON `purchase_payment_request_links` (`tenant_id`,`payment_id`) WHERE "purchase_payment_request_links"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_payment_request_links_request` ON `purchase_payment_request_links` (`tenant_id`,`request_id`,`detached_at`);--> statement-breakpoint
CREATE TABLE `purchase_payment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`requested_by_member_id` text NOT NULL,
	`business_type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`due_on` text NOT NULL,
	`reason` text NOT NULL,
	`reference` text,
	`submission_hash` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`reviewed_by_member_id` text,
	`review_note` text,
	`reviewed_at` text,
	`closed_by_member_id` text,
	`close_note` text,
	`closed_at` text,
	`last_operation_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_payment_requests_amount" CHECK("purchase_payment_requests"."amount_minor" > 0),
	CONSTRAINT "ck_payment_requests_currency" CHECK("purchase_payment_requests"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "ck_payment_requests_type" CHECK("purchase_payment_requests"."business_type" IN ('prepayment', 'balance')),
	CONSTRAINT "ck_payment_requests_status" CHECK("purchase_payment_requests"."status" IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
	CONSTRAINT "ck_payment_requests_version" CHECK("purchase_payment_requests"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_payment_requests_order` ON `purchase_payment_requests` (`tenant_id`,`purchase_order_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_payment_requests_requester` ON `purchase_payment_requests` (`tenant_id`,`requested_by_member_id`,`created_at`);
