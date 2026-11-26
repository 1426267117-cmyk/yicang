CREATE TABLE `purchase_quality_inspection_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`passed_qty` integer NOT NULL,
	`rejected_qty` integer NOT NULL,
	`defect_reason` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inspection_id`) REFERENCES `purchase_quality_inspections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_quality_inspection_line_quantities" CHECK(
      typeof("purchase_quality_inspection_lines"."passed_qty") = 'integer' AND typeof("purchase_quality_inspection_lines"."rejected_qty") = 'integer'
      AND "purchase_quality_inspection_lines"."passed_qty" >= 0 AND "purchase_quality_inspection_lines"."rejected_qty" >= 0
      AND "purchase_quality_inspection_lines"."passed_qty" + "purchase_quality_inspection_lines"."rejected_qty" BETWEEN 1 AND 1000000
    ),
	CONSTRAINT "ck_purchase_quality_inspection_defect_reason" CHECK(
      ("purchase_quality_inspection_lines"."rejected_qty" = 0 AND "purchase_quality_inspection_lines"."defect_reason" IS NULL)
      OR ("purchase_quality_inspection_lines"."rejected_qty" > 0 AND "purchase_quality_inspection_lines"."defect_reason" IS NOT NULL AND length(trim("purchase_quality_inspection_lines"."defect_reason")) BETWEEN 1 AND 500)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_quality_inspection_order_line` ON `purchase_quality_inspection_lines` (`inspection_id`,`purchase_order_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_quality_inspection_lines_inspection` ON `purchase_quality_inspection_lines` (`tenant_id`,`inspection_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_quality_inspection_lines_order_line` ON `purchase_quality_inspection_lines` (`tenant_id`,`purchase_order_line_id`);--> statement-breakpoint
CREATE TABLE `purchase_quality_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`batch_reference` text NOT NULL,
	`note` text,
	`created_by_member_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_quality_batch_reference" CHECK(length(trim("purchase_quality_inspections"."batch_reference")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_purchase_quality_inspection_note" CHECK("purchase_quality_inspections"."note" IS NULL OR length(trim("purchase_quality_inspections"."note")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_quality_inspections_operation` ON `purchase_quality_inspections` (`tenant_id`,`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_quality_inspections_batch` ON `purchase_quality_inspections` (`tenant_id`,`purchase_order_id`,lower("batch_reference"));--> statement-breakpoint
CREATE INDEX `idx_purchase_quality_inspections_order` ON `purchase_quality_inspections` (`tenant_id`,`purchase_order_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `purchase_quality_requirements` (
	`purchase_order_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_quality_requirement_reason" CHECK(length(trim("purchase_quality_requirements"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_quality_requirements_operation` ON `purchase_quality_requirements` (`tenant_id`,`operation_key`);
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_requirements_validate
BEFORE INSERT ON purchase_quality_requirements
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_QUALITY_REQUIREMENT_CLOSED') WHERE NOT EXISTS (
    SELECT 1 FROM purchase_orders po
    JOIN warehouses warehouse ON warehouse.id = po.delivery_warehouse_id AND warehouse.tenant_id = po.tenant_id
    JOIN purchase_requests request ON request.id = po.purchase_request_id AND request.tenant_id = po.tenant_id
    JOIN members actor ON actor.id = NEW.created_by_member_id AND actor.tenant_id = po.tenant_id
    WHERE po.id = NEW.purchase_order_id AND po.tenant_id = NEW.tenant_id AND po.status IN ('draft', 'issued')
      AND (actor.role = 'admin' OR (actor.role = 'operator' AND actor.id = request.purchaser_member_id))
  ) OR EXISTS (
    SELECT 1 FROM purchase_receipts receipt
    WHERE receipt.tenant_id = NEW.tenant_id AND receipt.purchase_order_id = NEW.purchase_order_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspections_validate
BEFORE INSERT ON purchase_quality_inspections
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_QUALITY_NOT_INSPECTABLE') WHERE NOT EXISTS (
    SELECT 1 FROM purchase_orders po
    JOIN purchase_quality_requirements requirement
      ON requirement.purchase_order_id = po.id AND requirement.tenant_id = po.tenant_id
    JOIN warehouses warehouse ON warehouse.id = po.delivery_warehouse_id AND warehouse.tenant_id = po.tenant_id
    JOIN members actor ON actor.id = NEW.created_by_member_id AND actor.tenant_id = po.tenant_id
    WHERE po.id = NEW.purchase_order_id AND po.tenant_id = NEW.tenant_id
      AND po.status IN ('issued', 'partially_received') AND actor.role IN ('admin', 'operator')
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspection_lines_validate
BEFORE INSERT ON purchase_quality_inspection_lines
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_QUALITY_LINE_INVALID') WHERE NOT EXISTS (
    SELECT 1
    FROM purchase_quality_inspections inspection
    JOIN purchase_order_lines purchase_line
      ON purchase_line.purchase_order_id = inspection.purchase_order_id AND purchase_line.tenant_id = inspection.tenant_id
    WHERE inspection.id = NEW.inspection_id AND inspection.tenant_id = NEW.tenant_id
      AND purchase_line.id = NEW.purchase_order_line_id
  );
  SELECT RAISE(ABORT, 'PURCHASE_QUALITY_EXCEEDS_INSPECTABLE') WHERE NEW.passed_qty + NEW.rejected_qty > (
    SELECT purchase_line.ordered_quantity - purchase_line.received_quantity - MAX(0,
      COALESCE((SELECT SUM(checked.passed_qty) FROM purchase_quality_inspection_lines checked
        WHERE checked.tenant_id = NEW.tenant_id AND checked.purchase_order_line_id = NEW.purchase_order_line_id), 0)
      - COALESCE((SELECT SUM(received.quantity) FROM purchase_receipt_lines received
        WHERE received.tenant_id = NEW.tenant_id AND received.purchase_order_line_id = NEW.purchase_order_line_id), 0)
    )
    FROM purchase_order_lines purchase_line
    WHERE purchase_line.id = NEW.purchase_order_line_id AND purchase_line.tenant_id = NEW.tenant_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_receipt_lines_quality_gate
BEFORE INSERT ON purchase_receipt_lines
WHEN EXISTS (
  SELECT 1 FROM purchase_receipts receipt
  JOIN purchase_quality_requirements requirement
    ON requirement.purchase_order_id = receipt.purchase_order_id AND requirement.tenant_id = receipt.tenant_id
  WHERE receipt.id = NEW.purchase_receipt_id AND receipt.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_RECEIPT_QUALITY_LIMIT') WHERE NEW.quantity > (
    COALESCE((SELECT SUM(checked.passed_qty) FROM purchase_quality_inspection_lines checked
      WHERE checked.tenant_id = NEW.tenant_id AND checked.purchase_order_line_id = NEW.purchase_order_line_id), 0)
    - COALESCE((SELECT SUM(received.quantity) FROM purchase_receipt_lines received
      WHERE received.tenant_id = NEW.tenant_id AND received.purchase_order_line_id = NEW.purchase_order_line_id), 0)
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_requirements_immutable_update
BEFORE UPDATE ON purchase_quality_requirements
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_requirements_immutable_delete
BEFORE DELETE ON purchase_quality_requirements
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspections_immutable_update
BEFORE UPDATE ON purchase_quality_inspections
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspections_immutable_delete
BEFORE DELETE ON purchase_quality_inspections
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspection_lines_immutable_update
BEFORE UPDATE ON purchase_quality_inspection_lines
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_quality_inspection_lines_immutable_delete
BEFORE DELETE ON purchase_quality_inspection_lines
BEGIN SELECT RAISE(ABORT, 'PURCHASE_QUALITY_IMMUTABLE'); END;
