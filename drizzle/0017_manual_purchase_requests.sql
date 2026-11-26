ALTER TABLE purchase_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'
	CONSTRAINT ck_purchase_requests_source CHECK (source IN ('legacy', 'planning', 'manual'))
	CONSTRAINT ck_manual_purchase_requests_note CHECK (
		source <> 'manual' OR (note IS NOT NULL AND length(trim(note)) > 0)
	);
--> statement-breakpoint
UPDATE purchase_requests
SET source = 'planning'
WHERE EXISTS (
	SELECT 1 FROM audit_logs audit
	WHERE audit.tenant_id = purchase_requests.tenant_id
		AND audit.entity_type = 'purchase_request'
		AND audit.entity_id = purchase_requests.id
		AND audit.action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
);
--> statement-breakpoint
-- Wrangler applies this migration in one D1 batch. Defer the existing PO-line
-- foreign keys while the referenced request-line table is rebuilt.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
DROP TRIGGER trg_purchase_requests_validate_active_demands;
--> statement-breakpoint
DROP TRIGGER trg_purchase_orders_validate_insert;
--> statement-breakpoint
DROP TRIGGER trg_purchase_order_lines_validate_insert;
--> statement-breakpoint
DROP TRIGGER trg_purchase_orders_release_closed_remainders;
--> statement-breakpoint
DROP TRIGGER trg_purchase_receipt_correction_lines_post_inventory;
--> statement-breakpoint
CREATE TABLE `__new_purchase_request_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`purchase_demand_id` text,
	`sku_id` text NOT NULL,
	`requested_quantity` integer NOT NULL,
	`source_required_quantity` integer,
	`source_updated_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `purchase_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_demand_id`) REFERENCES `purchase_demands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_request_lines_quantity_positive" CHECK("__new_purchase_request_lines"."requested_quantity" > 0),
	CONSTRAINT "ck_purchase_request_lines_source_fields" CHECK(
    ("__new_purchase_request_lines"."purchase_demand_id" IS NULL AND "__new_purchase_request_lines"."source_required_quantity" IS NULL AND "__new_purchase_request_lines"."source_updated_at" IS NULL)
    OR ("__new_purchase_request_lines"."purchase_demand_id" IS NOT NULL AND "__new_purchase_request_lines"."source_required_quantity" IS NOT NULL AND "__new_purchase_request_lines"."source_updated_at" IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO `__new_purchase_request_lines` (
	id, tenant_id, request_id, purchase_demand_id, sku_id, requested_quantity,
	source_required_quantity, source_updated_at, active, created_at
)
SELECT id, tenant_id, request_id, purchase_demand_id, sku_id, requested_quantity,
	source_required_quantity, source_updated_at, active, created_at
FROM purchase_request_lines;--> statement-breakpoint
DROP TABLE `purchase_request_lines`;--> statement-breakpoint
ALTER TABLE `__new_purchase_request_lines` RENAME TO `purchase_request_lines`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_request_lines_request_demand` ON `purchase_request_lines` (`request_id`,`purchase_demand_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_request_lines_active_demand` ON `purchase_request_lines` (`tenant_id`,`purchase_demand_id`) WHERE "purchase_request_lines"."active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_request_lines_manual_sku` ON `purchase_request_lines` (`request_id`,`sku_id`) WHERE "purchase_request_lines"."purchase_demand_id" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_purchase_request_lines_request` ON `purchase_request_lines` (`tenant_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_request_lines_demand` ON `purchase_request_lines` (`tenant_id`,`purchase_demand_id`);--> statement-breakpoint
CREATE TRIGGER trg_purchase_requests_source_immutable
BEFORE UPDATE OF source ON purchase_requests
FOR EACH ROW WHEN NEW.source <> OLD.source
BEGIN
	SELECT RAISE(ABORT, 'PURCHASE_REQUEST_SOURCE_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_request_lines_validate_insert
BEFORE INSERT ON purchase_request_lines
FOR EACH ROW
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM purchase_requests pr
		WHERE pr.id = NEW.request_id AND pr.tenant_id = NEW.tenant_id
			AND (
				(pr.source = 'manual' AND pr.status = 'draft' AND NEW.purchase_demand_id IS NULL AND EXISTS (
					SELECT 1 FROM skus sku
					WHERE sku.id = NEW.sku_id AND sku.tenant_id = NEW.tenant_id AND sku.active = 1
				))
				OR (pr.source <> 'manual' AND NEW.purchase_demand_id IS NOT NULL)
			)
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_DEMAND') END;
	SELECT CASE WHEN NEW.active = 1 AND NEW.purchase_demand_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM purchase_demands pd
		WHERE pd.id = NEW.purchase_demand_id
			AND pd.tenant_id = NEW.tenant_id
			AND pd.status = 'open'
			AND pd.mapped_sku_id = NEW.sku_id
			AND pd.required_quantity >= NEW.requested_quantity
	) THEN RAISE(ABORT, 'INVALID_PURCHASE_DEMAND') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_request_lines_source_immutable
BEFORE UPDATE OF tenant_id, request_id, purchase_demand_id ON purchase_request_lines
FOR EACH ROW WHEN NEW.tenant_id <> OLD.tenant_id
	OR NEW.request_id <> OLD.request_id OR NEW.purchase_demand_id IS NOT OLD.purchase_demand_id
BEGIN
	SELECT RAISE(ABORT, 'PURCHASE_REQUEST_SOURCE_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_requests_validate_active_demands
BEFORE UPDATE OF status ON purchase_requests
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
		LEFT JOIN skus sku ON sku.id = line.sku_id AND sku.tenant_id = line.tenant_id
		WHERE line.request_id = NEW.id
			AND line.tenant_id = NEW.tenant_id
			AND line.active = 1
			AND (
				(NEW.source = 'manual' AND (line.purchase_demand_id IS NOT NULL OR sku.id IS NULL OR sku.active <> 1))
				OR (NEW.source <> 'manual' AND (
					pd.id IS NULL OR pd.status <> 'open' OR pd.mapped_sku_id <> line.sku_id
					OR pd.required_quantity < line.requested_quantity
				))
			)
	) THEN RAISE(ABORT, 'PURCHASE_DEMAND_CHANGED') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_purchase_orders_validate_insert
BEFORE INSERT ON purchase_orders
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
-- SQLite counts the temporary missing parents when dropping the old table.
-- Assert that every PO line still has its original request line before clearing the deferral.
CREATE TABLE __manual_purchase_fk_check (valid INTEGER NOT NULL);
--> statement-breakpoint
INSERT INTO __manual_purchase_fk_check (valid)
SELECT NULL FROM purchase_order_lines po_line
LEFT JOIN purchase_request_lines request_line ON request_line.id = po_line.purchase_request_line_id
WHERE request_line.id IS NULL LIMIT 1;
--> statement-breakpoint
DROP TABLE __manual_purchase_fk_check;
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
