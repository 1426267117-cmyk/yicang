ALTER TABLE `purchase_orders` ADD `delivery_warehouse_id` text REFERENCES warehouses(id);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `expected_delivery_at` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `payment_terms` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `trade_terms` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_code_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_name_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_contact_name_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_contact_phone_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_contact_email_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_address_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `delivery_warehouse_code_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `delivery_warehouse_name_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `delivery_contact_name_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `delivery_contact_phone_snapshot` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `delivery_address_snapshot` text;--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_delivery_warehouse` ON `purchase_orders` (`tenant_id`,`delivery_warehouse_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `contact_name` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `contact_phone` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `contact_email` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `address` text;--> statement-breakpoint
ALTER TABLE `warehouses` ADD `contact_name` text;--> statement-breakpoint
ALTER TABLE `warehouses` ADD `contact_phone` text;--> statement-breakpoint
ALTER TABLE `warehouses` ADD `address` text;--> statement-breakpoint
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
