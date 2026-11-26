CREATE TABLE `logistics_tracking_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`package_id` text NOT NULL,
	`version` integer NOT NULL,
	`carrier` text NOT NULL,
	`tracking_number` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_logistics_version" CHECK("logistics_tracking_events"."version" > 0),
	CONSTRAINT "ck_logistics_status" CHECK("logistics_tracking_events"."status" IN ('registered', 'in_transit', 'exception', 'delivered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_logistics_package_version` ON `logistics_tracking_events` (`tenant_id`,`package_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_logistics_idempotency` ON `logistics_tracking_events` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_logistics_order_package` ON `logistics_tracking_events` (`tenant_id`,`order_id`,`package_id`,`version`);
--> statement-breakpoint
CREATE TRIGGER trg_logistics_tracking_events_no_update
BEFORE UPDATE ON logistics_tracking_events
BEGIN
  SELECT RAISE(ABORT, 'LOGISTICS_TRACKING_EVENT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_logistics_tracking_events_no_delete
BEFORE DELETE ON logistics_tracking_events
BEGIN
  SELECT RAISE(ABORT, 'LOGISTICS_TRACKING_EVENT_IMMUTABLE');
END;
