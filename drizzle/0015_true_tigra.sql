ALTER TABLE `purchase_orders` ADD `closed_at` text;
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
DROP TRIGGER `trg_purchase_orders_validate_transition`;
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
DROP TRIGGER `trg_purchase_receipt_correction_lines_post_inventory`;
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
