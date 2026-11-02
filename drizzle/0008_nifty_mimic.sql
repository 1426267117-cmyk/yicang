CREATE TABLE `purchase_request_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`purchase_demand_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`requested_quantity` integer NOT NULL,
	`source_required_quantity` integer NOT NULL,
	`source_updated_at` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `purchase_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_demand_id`) REFERENCES `purchase_demands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_request_lines_quantity_positive" CHECK("purchase_request_lines"."requested_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_request_lines_request_demand` ON `purchase_request_lines` (`request_id`,`purchase_demand_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_request_lines_active_demand` ON `purchase_request_lines` (`tenant_id`,`purchase_demand_id`) WHERE "purchase_request_lines"."active" = 1;--> statement-breakpoint
CREATE INDEX `idx_purchase_request_lines_request` ON `purchase_request_lines` (`tenant_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_request_lines_demand` ON `purchase_request_lines` (`tenant_id`,`purchase_demand_id`);--> statement-breakpoint
CREATE TABLE `purchase_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_no` text NOT NULL,
	`status` text NOT NULL,
	`purchaser_member_id` text NOT NULL,
	`reviewer_member_id` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`note` text,
	`review_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`last_action_key` text NOT NULL,
	`submitted_at` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchaser_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_requests_number` ON `purchase_requests` (`tenant_id`,`request_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_requests_idempotency` ON `purchase_requests` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_purchase_requests_status` ON `purchase_requests` (`tenant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_requests_purchaser` ON `purchase_requests` (`tenant_id`,`purchaser_member_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_requests_reviewer` ON `purchase_requests` (`tenant_id`,`reviewer_member_id`);--> statement-breakpoint
CREATE TRIGGER `trg_purchase_request_lines_validate_insert`
BEFORE INSERT ON `purchase_request_lines`
FOR EACH ROW WHEN NEW.active = 1
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_demands pd
		JOIN purchase_requests pr
			ON pr.id = NEW.request_id AND pr.tenant_id = NEW.tenant_id
		WHERE pd.id = NEW.purchase_demand_id
			AND pd.tenant_id = NEW.tenant_id
			AND pd.status = 'open'
			AND pd.mapped_sku_id = NEW.sku_id
			AND pd.required_quantity >= NEW.requested_quantity
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_DEMAND') END;
END;--> statement-breakpoint
CREATE TRIGGER `trg_purchase_requests_validate_transition`
BEFORE UPDATE OF status ON `purchase_requests`
FOR EACH ROW WHEN NOT (
	(OLD.status = 'draft' AND NEW.status IN ('pending_review', 'cancelled'))
	OR (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PURCHASE_REQUEST_TRANSITION');
END;--> statement-breakpoint
CREATE TRIGGER `trg_purchase_requests_validate_active_demands`
BEFORE UPDATE OF status ON `purchase_requests`
FOR EACH ROW WHEN NEW.status IN ('pending_review', 'approved')
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM purchase_request_lines line
		WHERE line.request_id = NEW.id AND line.tenant_id = NEW.tenant_id AND line.active = 1
	) THEN RAISE(ABORT, 'PURCHASE_REQUEST_HAS_NO_ACTIVE_LINES') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM purchase_request_lines line
		LEFT JOIN purchase_demands pd
			ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
		WHERE line.request_id = NEW.id
			AND line.tenant_id = NEW.tenant_id
			AND line.active = 1
			AND (
				pd.id IS NULL OR pd.status <> 'open' OR pd.mapped_sku_id <> line.sku_id
				OR pd.required_quantity < line.requested_quantity
			)
	) THEN RAISE(ABORT, 'PURCHASE_DEMAND_CHANGED') END;
END;
