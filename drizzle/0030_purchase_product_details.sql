-- Rebuild the existing order headers in a single migration transaction.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
DROP TRIGGER trg_purchase_receipts_validate_insert;
--> statement-breakpoint
DROP TRIGGER trg_purchase_receipt_lines_validate_insert;
--> statement-breakpoint
DROP TRIGGER trg_purchase_receipt_lines_post_inventory;
--> statement-breakpoint
DROP TRIGGER trg_purchase_requests_prevent_withdraw_with_active_order;
--> statement-breakpoint
DROP TRIGGER trg_purchase_order_lines_validate_insert;
--> statement-breakpoint
DROP TRIGGER trg_purchase_receipt_correction_lines_post_inventory;
--> statement-breakpoint
DROP TRIGGER trg_purchase_quality_requirements_validate;
--> statement-breakpoint
DROP TRIGGER trg_purchase_quality_inspections_validate;
--> statement-breakpoint
CREATE TABLE `__new_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_no` text NOT NULL,
	`purchase_request_id` text NOT NULL,
	`supplier_id` text,
	`delivery_warehouse_id` text,
	`expected_delivery_at` text,
	`payment_terms` text,
	`trade_terms` text,
	`supplier_code_snapshot` text,
	`supplier_name_snapshot` text,
	`supplier_contact_name_snapshot` text,
	`supplier_contact_phone_snapshot` text,
	`supplier_contact_email_snapshot` text,
	`supplier_address_snapshot` text,
	`delivery_warehouse_code_snapshot` text,
	`delivery_warehouse_name_snapshot` text,
	`delivery_contact_name_snapshot` text,
	`delivery_contact_phone_snapshot` text,
	`delivery_address_snapshot` text,
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
	`closed_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_request_id`) REFERENCES `purchase_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_purchase_orders`("id", "tenant_id", "order_no", "purchase_request_id", "supplier_id", "delivery_warehouse_id", "expected_delivery_at", "payment_terms", "trade_terms", "supplier_code_snapshot", "supplier_name_snapshot", "supplier_contact_name_snapshot", "supplier_contact_phone_snapshot", "supplier_contact_email_snapshot", "supplier_address_snapshot", "delivery_warehouse_code_snapshot", "delivery_warehouse_name_snapshot", "delivery_contact_name_snapshot", "delivery_contact_phone_snapshot", "delivery_address_snapshot", "status", "currency", "note", "action_note", "version", "idempotency_key", "request_hash", "last_action_key", "created_by_member_id", "issued_at", "closed_at", "cancelled_at", "created_at", "updated_at") SELECT "id", "tenant_id", "order_no", "purchase_request_id", "supplier_id", "delivery_warehouse_id", "expected_delivery_at", "payment_terms", "trade_terms", "supplier_code_snapshot", "supplier_name_snapshot", "supplier_contact_name_snapshot", "supplier_contact_phone_snapshot", "supplier_contact_email_snapshot", "supplier_address_snapshot", "delivery_warehouse_code_snapshot", "delivery_warehouse_name_snapshot", "delivery_contact_name_snapshot", "delivery_contact_phone_snapshot", "delivery_address_snapshot", "status", "currency", "note", "action_note", "version", "idempotency_key", "request_hash", "last_action_key", "created_by_member_id", "issued_at", "closed_at", "cancelled_at", "created_at", "updated_at" FROM `purchase_orders`;
--> statement-breakpoint
DROP TABLE `purchase_orders`;
--> statement-breakpoint
ALTER TABLE `__new_purchase_orders` RENAME TO `purchase_orders`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_number` ON `purchase_orders` (`tenant_id`,`order_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_idempotency` ON `purchase_orders` (`tenant_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_active_request` ON `purchase_orders` (`tenant_id`,`purchase_request_id`) WHERE "purchase_orders"."status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_status` ON `purchase_orders` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_supplier` ON `purchase_orders` (`tenant_id`,`supplier_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_delivery_warehouse` ON `purchase_orders` (`tenant_id`,`delivery_warehouse_id`,`updated_at`);
--> statement-breakpoint
ALTER TABLE `purchase_order_lines` ADD `product_details_json` text;
--> statement-breakpoint
ALTER TABLE `purchase_request_lines` ADD `product_details_json` text;
--> statement-breakpoint
ALTER TABLE `skus` ADD `specification` text;
--> statement-breakpoint
ALTER TABLE `skus` ADD `dimensions` text;
--> statement-breakpoint
ALTER TABLE `skus` ADD `image_url` text;
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
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_requests_prevent_withdraw_with_active_order`
BEFORE UPDATE OF `status` ON `purchase_requests`
FOR EACH ROW WHEN OLD.status = 'approved' AND NEW.status = 'cancelled' AND EXISTS (
	SELECT 1
	FROM purchase_orders purchase_order
	WHERE purchase_order.tenant_id = OLD.tenant_id
		AND purchase_order.purchase_request_id = OLD.id
		AND purchase_order.status <> 'cancelled'
)
BEGIN
	SELECT RAISE(ABORT, 'PURCHASE_REQUEST_HAS_ACTIVE_ORDER');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_validate_transition`
BEFORE UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT (
	(OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
	OR (OLD.status = 'issued' AND NEW.status IN ('partially_received', 'received', 'closed_short'))
	OR (OLD.status = 'partially_received' AND NEW.status IN ('received', 'closed_short'))
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
CREATE TRIGGER `trg_purchase_orders_validate_close_reason`
BEFORE UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status = 'closed_short' AND OLD.status <> 'closed_short'
	AND (NEW.action_note IS NULL OR trim(NEW.action_note) = '' OR NEW.closed_at IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'PURCHASE_ORDER_CLOSE_REASON_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_validate_delivery_warehouse_insert`
BEFORE INSERT ON `purchase_orders`
FOR EACH ROW WHEN NEW.delivery_warehouse_id IS NOT NULL AND NOT EXISTS (
	SELECT 1
	FROM warehouses warehouse
	WHERE warehouse.id = NEW.delivery_warehouse_id
		AND warehouse.tenant_id = NEW.tenant_id
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PURCHASE_DELIVERY_WAREHOUSE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_orders_validate_insert
BEFORE INSERT ON purchase_orders
FOR EACH ROW
BEGIN
	SELECT CASE WHEN (NEW.supplier_id IS NOT NULL OR NEW.status <> 'draft') AND NOT EXISTS (
		SELECT 1 FROM suppliers s
		WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id AND s.active = 1
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_SUPPLIER') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM purchase_requests pr
		WHERE pr.id = NEW.purchase_request_id AND pr.tenant_id = NEW.tenant_id AND pr.status = 'approved'
	) THEN RAISE(ABORT, 'PURCHASE_REQUEST_NOT_APPROVED') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM purchase_requests pr
		JOIN purchase_request_lines prl
			ON prl.request_id = pr.id AND prl.tenant_id = pr.tenant_id
		LEFT JOIN purchase_demands pd
			ON pd.id = prl.purchase_demand_id AND pd.tenant_id = prl.tenant_id
		LEFT JOIN skus sku ON sku.id = prl.sku_id AND sku.tenant_id = prl.tenant_id
		WHERE pr.id = NEW.purchase_request_id
			AND pr.tenant_id = NEW.tenant_id
			AND prl.active = 1
			AND (
				(pr.source = 'manual' AND (prl.purchase_demand_id IS NOT NULL OR sku.id IS NULL OR sku.active <> 1))
				OR (pr.source <> 'manual' AND (
					pd.id IS NULL OR pd.status <> 'open' OR pd.mapped_sku_id <> prl.sku_id
					OR pd.required_quantity < prl.requested_quantity
					OR pd.source_updated_at <> prl.source_updated_at
				))
			)
	) THEN RAISE(ABORT, 'PURCHASE_REQUEST_NEEDS_ATTENTION') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_order_lines_validate_insert
BEFORE INSERT ON purchase_order_lines
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
		LEFT JOIN skus sku ON sku.id = prl.sku_id AND sku.tenant_id = prl.tenant_id
		WHERE po.id = NEW.purchase_order_id
			AND po.tenant_id = NEW.tenant_id
			AND po.status = 'draft'
			AND pr.status = 'approved'
			AND prl.active = 1
			AND prl.sku_id = NEW.sku_id
			AND prl.requested_quantity = NEW.ordered_quantity
			AND (
				(pr.source = 'manual' AND prl.purchase_demand_id IS NULL AND sku.active = 1)
				OR (
					pr.source <> 'manual'
					AND pd.status = 'open'
					AND pd.mapped_sku_id = NEW.sku_id
					AND pd.required_quantity >= NEW.ordered_quantity
					AND pd.source_updated_at = prl.source_updated_at
				)
			)
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_ORDER_LINE') END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_orders_release_closed_remainders`
AFTER UPDATE OF `status` ON `purchase_orders`
FOR EACH ROW WHEN NEW.status = 'closed_short' AND OLD.status <> 'closed_short'
BEGIN
	UPDATE purchase_request_lines
	SET active = 0
	WHERE tenant_id = NEW.tenant_id
		AND request_id = NEW.purchase_request_id
		AND id IN (
			SELECT order_line.purchase_request_line_id
			FROM purchase_order_lines order_line
			WHERE order_line.tenant_id = NEW.tenant_id
				AND order_line.purchase_order_id = NEW.id
				AND order_line.received_quantity < order_line.ordered_quantity
		);
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

	UPDATE purchase_request_lines
	SET active = 0
	WHERE tenant_id = NEW.tenant_id
		AND id = (
			SELECT order_line.purchase_request_line_id
			FROM purchase_order_lines order_line
			JOIN purchase_orders purchase_order
				ON purchase_order.id = order_line.purchase_order_id
				AND purchase_order.tenant_id = order_line.tenant_id
			WHERE order_line.id = NEW.purchase_order_line_id
				AND order_line.tenant_id = NEW.tenant_id
				AND purchase_order.status = 'closed_short'
				AND order_line.received_quantity < order_line.ordered_quantity
		);

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
			WHEN purchase_orders.status = 'closed_short' THEN 'closed_short'
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
CREATE TRIGGER trg_purchase_orders_validate_supplier_update
BEFORE UPDATE OF supplier_id, status ON purchase_orders
FOR EACH ROW WHEN NEW.supplier_id IS NOT OLD.supplier_id
  OR (OLD.status = 'draft' AND NEW.status = 'issued')
BEGIN
  SELECT CASE WHEN (
    (NEW.status NOT IN ('draft', 'cancelled') OR NEW.supplier_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id AND s.active = 1
    )
  ) THEN RAISE(ABORT, 'INVALID_PURCHASE_SUPPLIER') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_orders_validate_delivery_warehouse_update
BEFORE UPDATE OF delivery_warehouse_id ON purchase_orders
FOR EACH ROW WHEN NEW.delivery_warehouse_id IS NOT NULL
  AND NEW.delivery_warehouse_id IS NOT OLD.delivery_warehouse_id
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.id = NEW.delivery_warehouse_id AND w.tenant_id = NEW.tenant_id
  ) THEN RAISE(ABORT, 'INVALID_PURCHASE_DELIVERY_WAREHOUSE') END;
END;
--> statement-breakpoint
-- Check every historical child reference before clearing the temporary SQLite deferral.
CREATE TABLE __purchase_orders_fk_check (valid INTEGER NOT NULL);
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM inventory_inbound_movements AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_order_lines AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_receipts AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM inventory_receipt_correction_movements AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_receipt_corrections AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_payments AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_invoices AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_quality_inspections AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_quality_requirements AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
INSERT INTO __purchase_orders_fk_check (valid)
SELECT NULL FROM purchase_payment_requests AS child
LEFT JOIN purchase_orders po ON po.id = child.purchase_order_id
WHERE child.purchase_order_id IS NOT NULL AND po.id IS NULL
LIMIT 1;
--> statement-breakpoint
DROP TABLE __purchase_orders_fk_check;
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
