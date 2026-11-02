CREATE TABLE `inventory_receipt_correction_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`correction_id` text NOT NULL,
	`correction_line_id` text NOT NULL,
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
	FOREIGN KEY (`correction_id`) REFERENCES `purchase_receipt_corrections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correction_line_id`) REFERENCES `purchase_receipt_correction_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_line_id`) REFERENCES `purchase_receipt_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_inventory_receipt_correction_delta_negative" CHECK("inventory_receipt_correction_movements"."on_hand_delta" < 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_receipt_correction_operation` ON `inventory_receipt_correction_movements` (`tenant_id`,`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_receipt_correction_line` ON `inventory_receipt_correction_movements` (`correction_line_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_receipt_correction_order` ON `inventory_receipt_correction_movements` (`tenant_id`,`purchase_order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_receipt_correction_sku_warehouse` ON `inventory_receipt_correction_movements` (`tenant_id`,`sku_id`,`warehouse_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `purchase_receipt_correction_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`correction_id` text NOT NULL,
	`purchase_receipt_line_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correction_id`) REFERENCES `purchase_receipt_corrections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_line_id`) REFERENCES `purchase_receipt_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_receipt_correction_lines_positive" CHECK("purchase_receipt_correction_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipt_correction_lines_source` ON `purchase_receipt_correction_lines` (`correction_id`,`purchase_receipt_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_correction_lines_receipt_line` ON `purchase_receipt_correction_lines` (`tenant_id`,`purchase_receipt_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_correction_lines_order_line` ON `purchase_receipt_correction_lines` (`tenant_id`,`purchase_order_line_id`);--> statement-breakpoint
CREATE TABLE `purchase_receipt_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`correction_no` text NOT NULL,
	`purchase_receipt_id` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipt_corrections_number` ON `purchase_receipt_corrections` (`tenant_id`,`correction_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_receipt_corrections_idempotency` ON `purchase_receipt_corrections` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_corrections_receipt` ON `purchase_receipt_corrections` (`tenant_id`,`purchase_receipt_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_receipt_corrections_order` ON `purchase_receipt_corrections` (`tenant_id`,`purchase_order_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipt_corrections_validate_insert`
BEFORE INSERT ON `purchase_receipt_corrections`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NEW.status <> 'posted'
		THEN RAISE(ABORT, 'INVALID_RECEIPT_CORRECTION') END;
	SELECT CASE WHEN LENGTH(TRIM(NEW.reason)) < 2
		THEN RAISE(ABORT, 'INVALID_RECEIPT_CORRECTION') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_receipts receipt
		WHERE receipt.id = NEW.purchase_receipt_id
			AND receipt.tenant_id = NEW.tenant_id
			AND receipt.status = 'posted'
			AND receipt.purchase_order_id = NEW.purchase_order_id
			AND receipt.warehouse_id = NEW.warehouse_id
	) THEN RAISE(ABORT, 'INVALID_RECEIPT_CORRECTION') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM members member
		WHERE member.id = NEW.created_by_member_id AND member.tenant_id = NEW.tenant_id
	) THEN RAISE(ABORT, 'INVALID_RECEIPT_CORRECTION') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipt_correction_lines_validate_insert`
BEFORE INSERT ON `purchase_receipt_correction_lines`
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_receipt_corrections correction
		JOIN purchase_receipt_lines receipt_line
			ON receipt_line.id = NEW.purchase_receipt_line_id
			AND receipt_line.tenant_id = correction.tenant_id
		JOIN inventory_balances balance
			ON balance.tenant_id = correction.tenant_id
			AND balance.sku_id = NEW.sku_id
			AND balance.warehouse_id = NEW.warehouse_id
		WHERE correction.id = NEW.correction_id
			AND correction.tenant_id = NEW.tenant_id
			AND correction.status = 'posted'
			AND receipt_line.purchase_receipt_id = correction.purchase_receipt_id
			AND receipt_line.purchase_order_line_id = NEW.purchase_order_line_id
			AND receipt_line.sku_id = NEW.sku_id
			AND receipt_line.warehouse_id = NEW.warehouse_id
			AND correction.warehouse_id = NEW.warehouse_id
			AND NEW.quantity > 0
	) THEN RAISE(ABORT, 'INVALID_RECEIPT_CORRECTION_LINE') END;
	SELECT CASE WHEN NEW.quantity + COALESCE((
		SELECT SUM(previous.quantity)
		FROM purchase_receipt_correction_lines previous
		WHERE previous.tenant_id = NEW.tenant_id
			AND previous.purchase_receipt_line_id = NEW.purchase_receipt_line_id
	), 0) > (
		SELECT receipt_line.quantity
		FROM purchase_receipt_lines receipt_line
		WHERE receipt_line.id = NEW.purchase_receipt_line_id
			AND receipt_line.tenant_id = NEW.tenant_id
	) THEN RAISE(ABORT, 'CORRECTION_EXCEEDS_RECEIPT') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM inventory_balances balance
		WHERE balance.tenant_id = NEW.tenant_id
			AND balance.sku_id = NEW.sku_id
			AND balance.warehouse_id = NEW.warehouse_id
			AND balance.on_hand_qty - NEW.quantity < balance.reserved_qty
	) THEN RAISE(ABORT, 'CORRECTION_INVENTORY_UNAVAILABLE') END;
END;
--> statement-breakpoint
DROP TRIGGER `trg_purchase_orders_validate_transition`;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_validate_transition`
BEFORE UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT (
	(OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
	OR (OLD.status = 'issued' AND NEW.status IN ('partially_received', 'received'))
	OR (OLD.status = 'partially_received' AND NEW.status = 'received')
	OR (
		(
			(OLD.status = 'received' AND NEW.status IN ('partially_received', 'issued'))
			OR (OLD.status = 'partially_received' AND NEW.status = 'issued')
		)
		AND EXISTS (
			SELECT 1
			FROM purchase_receipt_correction_lines correction_line
			JOIN purchase_receipt_corrections correction
				ON correction.id = correction_line.correction_id
				AND correction.tenant_id = correction_line.tenant_id
			WHERE correction.tenant_id = OLD.tenant_id
				AND correction.purchase_order_id = OLD.id
				AND correction.status = 'posted'
				AND correction_line.created_at = NEW.updated_at
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PURCHASE_ORDER_TRANSITION');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_receipt_correction_lines_post_inventory`
AFTER INSERT ON `purchase_receipt_correction_lines`
FOR EACH ROW
BEGIN
	UPDATE purchase_order_lines
	SET received_quantity = received_quantity - NEW.quantity,
		updated_at = NEW.created_at
	WHERE id = NEW.purchase_order_line_id AND tenant_id = NEW.tenant_id;

	UPDATE inventory_balances
	SET on_hand_qty = on_hand_qty - NEW.quantity,
		version = version + 1,
		updated_at = NEW.created_at
	WHERE tenant_id = NEW.tenant_id
		AND sku_id = NEW.sku_id
		AND warehouse_id = NEW.warehouse_id;

	INSERT INTO inventory_receipt_correction_movements (
		id, tenant_id, correction_id, correction_line_id,
		purchase_receipt_id, purchase_receipt_line_id,
		purchase_order_id, purchase_order_line_id, sku_id, warehouse_id,
		type, on_hand_delta, operation_key, created_by, created_at
	)
	SELECT
		lower(hex(randomblob(16))), NEW.tenant_id, NEW.correction_id, NEW.id,
		correction.purchase_receipt_id, NEW.purchase_receipt_line_id,
		correction.purchase_order_id, NEW.purchase_order_line_id, NEW.sku_id, NEW.warehouse_id,
		'purchase_receipt_correction', -NEW.quantity, NEW.id || ':purchase_receipt_correction',
		member.auth_user_id, NEW.created_at
	FROM purchase_receipt_corrections correction
	JOIN members member
		ON member.id = correction.created_by_member_id AND member.tenant_id = correction.tenant_id
	WHERE correction.id = NEW.correction_id AND correction.tenant_id = NEW.tenant_id;

	UPDATE purchase_orders
	SET status = CASE
			WHEN NOT EXISTS (
				SELECT 1 FROM purchase_order_lines remaining
				WHERE remaining.purchase_order_id = purchase_orders.id
					AND remaining.tenant_id = purchase_orders.tenant_id
					AND remaining.received_quantity < remaining.ordered_quantity
			) THEN 'received'
			WHEN EXISTS (
				SELECT 1 FROM purchase_order_lines received
				WHERE received.purchase_order_id = purchase_orders.id
					AND received.tenant_id = purchase_orders.tenant_id
					AND received.received_quantity > 0
			) THEN 'partially_received'
			ELSE 'issued'
		END,
		version = version + 1,
		updated_at = NEW.created_at
	WHERE id = (
		SELECT correction.purchase_order_id
		FROM purchase_receipt_corrections correction
		WHERE correction.id = NEW.correction_id AND correction.tenant_id = NEW.tenant_id
	) AND tenant_id = NEW.tenant_id;
END;
