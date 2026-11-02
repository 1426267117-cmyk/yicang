CREATE TABLE `inventory_inbound_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_receipt_id` text NOT NULL,
	`purchase_receipt_line_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`type` text NOT NULL,
	`on_hand_delta` integer NOT NULL,
	`operation_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_line_id`) REFERENCES `purchase_receipt_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_inventory_inbound_delta_positive" CHECK("inventory_inbound_movements"."on_hand_delta" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_inbound_tenant_operation` ON `inventory_inbound_movements` (`tenant_id`,`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_inbound_receipt_line` ON `inventory_inbound_movements` (`purchase_receipt_line_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_inbound_order` ON `inventory_inbound_movements` (`tenant_id`,`purchase_order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_inbound_sku_warehouse` ON `inventory_inbound_movements` (`tenant_id`,`sku_id`,`warehouse_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`purchase_request_line_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`sku_code_snapshot` text NOT NULL,
	`sku_name_snapshot` text NOT NULL,
	`ordered_quantity` integer NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`unit_cost_minor` integer,
	`currency` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_request_line_id`) REFERENCES `purchase_request_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_order_lines_ordered_positive" CHECK("purchase_order_lines"."ordered_quantity" > 0),
	CONSTRAINT "ck_purchase_order_lines_received_range" CHECK("purchase_order_lines"."received_quantity" >= 0 AND "purchase_order_lines"."received_quantity" <= "purchase_order_lines"."ordered_quantity"),
	CONSTRAINT "ck_purchase_order_lines_cost_non_negative" CHECK("purchase_order_lines"."unit_cost_minor" IS NULL OR "purchase_order_lines"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_order_lines_request_line` ON `purchase_order_lines` (`purchase_order_id`,`purchase_request_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_order_lines_order` ON `purchase_order_lines` (`tenant_id`,`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_order_lines_sku` ON `purchase_order_lines` (`tenant_id`,`sku_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_no` text NOT NULL,
	`purchase_request_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`status` text NOT NULL,
	`currency` text,
	`note` text,
	`action_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`last_action_key` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`issued_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_request_id`) REFERENCES `purchase_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_number` ON `purchase_orders` (`tenant_id`,`order_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_idempotency` ON `purchase_orders` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_active_request` ON `purchase_orders` (`tenant_id`,`purchase_request_id`) WHERE "purchase_orders"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_status` ON `purchase_orders` (`tenant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_supplier` ON `purchase_orders` (`tenant_id`,`supplier_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `purchase_receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`purchase_receipt_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_receipt_lines_quantity_positive" CHECK("purchase_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipt_lines_order_line` ON `purchase_receipt_lines` (`purchase_receipt_id`,`purchase_order_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_lines_receipt` ON `purchase_receipt_lines` (`tenant_id`,`purchase_receipt_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_lines_order_line` ON `purchase_receipt_lines` (`tenant_id`,`purchase_order_line_id`);--> statement-breakpoint
CREATE TABLE `purchase_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`receipt_no` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`received_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipts_number` ON `purchase_receipts` (`tenant_id`,`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipts_idempotency` ON `purchase_receipts` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipts_order` ON `purchase_receipts` (`tenant_id`,`purchase_order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipts_warehouse` ON `purchase_receipts` (`tenant_id`,`warehouse_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_suppliers_tenant_code` ON `suppliers` (`tenant_id`,`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_suppliers_tenant_idempotency` ON `suppliers` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_suppliers_tenant_active` ON `suppliers` (`tenant_id`,`active`,`name`);
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_validate_insert`
BEFORE INSERT ON `purchase_orders`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM suppliers s
		WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id AND s.active = 1
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_SUPPLIER') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM purchase_requests pr
		WHERE pr.id = NEW.purchase_request_id AND pr.tenant_id = NEW.tenant_id AND pr.status = 'approved'
	) THEN RAISE(ABORT, 'PURCHASE_REQUEST_NOT_APPROVED') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM purchase_request_lines prl
		LEFT JOIN purchase_demands pd
			ON pd.id = prl.purchase_demand_id AND pd.tenant_id = prl.tenant_id
		WHERE prl.request_id = NEW.purchase_request_id
			AND prl.tenant_id = NEW.tenant_id
			AND prl.active = 1
			AND (
				pd.id IS NULL OR pd.status <> 'open' OR pd.mapped_sku_id <> prl.sku_id
				OR pd.required_quantity < prl.requested_quantity
				OR pd.source_updated_at <> prl.source_updated_at
			)
	) THEN RAISE(ABORT, 'PURCHASE_REQUEST_NEEDS_ATTENTION') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_order_lines_validate_insert`
BEFORE INSERT ON `purchase_order_lines`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_orders po
		JOIN purchase_requests pr
			ON pr.id = po.purchase_request_id AND pr.tenant_id = po.tenant_id
		JOIN purchase_request_lines prl
			ON prl.id = NEW.purchase_request_line_id
			AND prl.request_id = pr.id
			AND prl.tenant_id = po.tenant_id
		LEFT JOIN purchase_demands pd
			ON pd.id = prl.purchase_demand_id AND pd.tenant_id = prl.tenant_id
		WHERE po.id = NEW.purchase_order_id
			AND po.tenant_id = NEW.tenant_id
			AND po.status = 'draft'
			AND pr.status = 'approved'
			AND prl.active = 1
			AND prl.sku_id = NEW.sku_id
			AND prl.requested_quantity = NEW.ordered_quantity
			AND pd.status = 'open'
			AND pd.mapped_sku_id = NEW.sku_id
			AND pd.required_quantity >= NEW.ordered_quantity
			AND pd.source_updated_at = prl.source_updated_at
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_ORDER_LINE') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_validate_transition`
BEFORE UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT (
	(OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
	OR (OLD.status = 'issued' AND NEW.status IN ('partially_received', 'received'))
	OR (OLD.status = 'partially_received' AND NEW.status = 'received')
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PURCHASE_ORDER_TRANSITION');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_prevent_cancel_after_receipt`
BEFORE UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status = 'cancelled' AND EXISTS (
	SELECT 1 FROM purchase_receipts receipt
	WHERE receipt.purchase_order_id = OLD.id AND receipt.tenant_id = OLD.tenant_id
)
BEGIN
	SELECT RAISE(ABORT, 'PURCHASE_ORDER_HAS_RECEIPTS');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipts_validate_insert`
BEFORE INSERT ON `purchase_receipts`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NEW.status <> 'posted' THEN RAISE(ABORT, 'INVALID_PURCHASE_RECEIPT_STATUS') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM purchase_orders po
		WHERE po.id = NEW.purchase_order_id AND po.tenant_id = NEW.tenant_id
			AND po.status IN ('issued', 'partially_received')
	) THEN RAISE(ABORT, 'PURCHASE_ORDER_NOT_RECEIVABLE') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM warehouses w
		WHERE w.id = NEW.warehouse_id AND w.tenant_id = NEW.tenant_id
	) THEN RAISE(ABORT, 'INVALID_RECEIPT_WAREHOUSE') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM members m
		WHERE m.id = NEW.created_by_member_id AND m.tenant_id = NEW.tenant_id
	) THEN RAISE(ABORT, 'INVALID_RECEIPT_ACTOR') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipt_lines_validate_insert`
BEFORE INSERT ON `purchase_receipt_lines`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_receipts receipt
		JOIN purchase_orders po
			ON po.id = receipt.purchase_order_id AND po.tenant_id = receipt.tenant_id
		JOIN purchase_order_lines line
			ON line.id = NEW.purchase_order_line_id
			AND line.purchase_order_id = po.id
			AND line.tenant_id = po.tenant_id
		WHERE receipt.id = NEW.purchase_receipt_id
			AND receipt.tenant_id = NEW.tenant_id
			AND receipt.status = 'posted'
			AND receipt.warehouse_id = NEW.warehouse_id
			AND po.status IN ('issued', 'partially_received')
			AND line.sku_id = NEW.sku_id
			AND NEW.quantity > 0
			AND line.received_quantity + NEW.quantity <= line.ordered_quantity
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_RECEIPT_LINE') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipt_lines_post_inventory`
AFTER INSERT ON `purchase_receipt_lines`
FOR EACH ROW
BEGIN
	UPDATE purchase_order_lines
	SET received_quantity = received_quantity + NEW.quantity,
		updated_at = NEW.created_at
	WHERE id = NEW.purchase_order_line_id AND tenant_id = NEW.tenant_id;

	INSERT INTO inventory_balances (
		id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at
	) VALUES (
		lower(hex(randomblob(16))), NEW.tenant_id, NEW.sku_id, NEW.warehouse_id,
		NEW.quantity, 0, 1, NEW.created_at
	)
	ON CONFLICT(tenant_id, sku_id, warehouse_id) DO UPDATE SET
		on_hand_qty = inventory_balances.on_hand_qty + excluded.on_hand_qty,
		version = inventory_balances.version + 1,
		updated_at = excluded.updated_at;

	INSERT INTO inventory_inbound_movements (
		id, tenant_id, purchase_receipt_id, purchase_receipt_line_id,
		purchase_order_id, purchase_order_line_id, sku_id, warehouse_id,
		type, on_hand_delta, operation_key, created_by, created_at
	)
	SELECT
		lower(hex(randomblob(16))), NEW.tenant_id, NEW.purchase_receipt_id, NEW.id,
		receipt.purchase_order_id, NEW.purchase_order_line_id, NEW.sku_id, NEW.warehouse_id,
		'purchase_receipt', NEW.quantity, NEW.id || ':purchase_receipt',
		member.auth_user_id, NEW.created_at
	FROM purchase_receipts receipt
	JOIN members member
		ON member.id = receipt.created_by_member_id AND member.tenant_id = receipt.tenant_id
	WHERE receipt.id = NEW.purchase_receipt_id AND receipt.tenant_id = NEW.tenant_id;

	UPDATE purchase_orders
	SET status = CASE WHEN NOT EXISTS (
			SELECT 1 FROM purchase_order_lines remaining
			WHERE remaining.purchase_order_id = purchase_orders.id
				AND remaining.tenant_id = purchase_orders.tenant_id
				AND remaining.received_quantity < remaining.ordered_quantity
		) THEN 'received' ELSE 'partially_received' END,
		version = version + 1,
		updated_at = NEW.created_at
	WHERE id = (
		SELECT receipt.purchase_order_id FROM purchase_receipts receipt
		WHERE receipt.id = NEW.purchase_receipt_id AND receipt.tenant_id = NEW.tenant_id
	) AND tenant_id = NEW.tenant_id;
END;
