CREATE TABLE `warehouse_stock_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`before_on_hand_qty` integer NOT NULL,
	`reserved_qty` integer NOT NULL,
	`counted_qty` integer NOT NULL,
	`inventory_version` integer NOT NULL,
	`reason` text NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_warehouse_stock_counts_quantities" CHECK(
      "warehouse_stock_counts"."reserved_qty" >= 0 AND "warehouse_stock_counts"."before_on_hand_qty" >= "warehouse_stock_counts"."reserved_qty"
      AND "warehouse_stock_counts"."counted_qty" >= "warehouse_stock_counts"."reserved_qty" AND "warehouse_stock_counts"."counted_qty" <= 2147483647
    ),
	CONSTRAINT "ck_warehouse_stock_counts_version" CHECK("warehouse_stock_counts"."inventory_version" >= 0),
	CONSTRAINT "ck_warehouse_stock_counts_reason" CHECK(length(trim("warehouse_stock_counts"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_warehouse_stock_counts_operation` ON `warehouse_stock_counts` (`tenant_id`,`operation_key`);--> statement-breakpoint
CREATE INDEX `idx_warehouse_stock_counts_history` ON `warehouse_stock_counts` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_warehouse_stock_counts_warehouse` ON `warehouse_stock_counts` (`tenant_id`,`warehouse_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_stock_counts_apply
AFTER INSERT ON warehouse_stock_counts
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM skus WHERE id = NEW.sku_id AND tenant_id = NEW.tenant_id
  ) OR NOT EXISTS (
    SELECT 1 FROM warehouses WHERE id = NEW.warehouse_id AND tenant_id = NEW.tenant_id
  );

  SELECT RAISE(ABORT, 'WAREHOUSE_STOCK_COUNT_VERSION_CONFLICT')
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_balances
    WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id
      AND version = NEW.inventory_version AND on_hand_qty = NEW.before_on_hand_qty
      AND reserved_qty = NEW.reserved_qty
    UNION ALL
    SELECT 1 WHERE NEW.inventory_version = 0 AND NEW.before_on_hand_qty = 0 AND NEW.reserved_qty = 0
      AND NOT EXISTS (
        SELECT 1 FROM inventory_balances
        WHERE tenant_id = NEW.tenant_id AND sku_id = NEW.sku_id AND warehouse_id = NEW.warehouse_id
      )
  );

  INSERT INTO inventory_balances (
    id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at
  ) VALUES (
    'inventory:stock-count:' || NEW.id, NEW.tenant_id, NEW.sku_id, NEW.warehouse_id,
    NEW.counted_qty, NEW.reserved_qty, NEW.inventory_version + 1, NEW.created_at
  ) ON CONFLICT (tenant_id, sku_id, warehouse_id) DO UPDATE SET
    on_hand_qty = excluded.on_hand_qty,
    version = excluded.version,
    updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_stock_counts_immutable_update
BEFORE UPDATE ON warehouse_stock_counts
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_STOCK_COUNT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_warehouse_stock_counts_immutable_delete
BEFORE DELETE ON warehouse_stock_counts
BEGIN
  SELECT RAISE(ABORT, 'WAREHOUSE_STOCK_COUNT_IMMUTABLE');
END;
