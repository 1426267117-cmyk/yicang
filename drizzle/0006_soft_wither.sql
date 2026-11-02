CREATE TABLE `purchase_demands` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_line_id` text NOT NULL,
	`platform` text NOT NULL,
	`source_order_id` text NOT NULL,
	`source_order_line_id` text NOT NULL,
	`raw_sku` text,
	`normalized_sku` text,
	`mapped_sku_id` text,
	`status` text NOT NULL,
	`ordered_quantity` integer NOT NULL,
	`current_quantity` integer,
	`unfulfilled_quantity` integer,
	`required_quantity` integer DEFAULT 0 NOT NULL,
	`reason_code` text,
	`source_updated_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_refreshed_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_store_id`) REFERENCES `platform_stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `platform_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `platform_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mapped_sku_id`) REFERENCES `skus`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_purchase_demands_required_non_negative" CHECK("purchase_demands"."required_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_demands_source` ON `purchase_demands` (`tenant_id`,`platform_store_id`,`source_order_id`,`source_order_line_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_demands_status` ON `purchase_demands` (`tenant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_demands_order` ON `purchase_demands` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_demands_mapped_sku` ON `purchase_demands` (`tenant_id`,`mapped_sku_id`);--> statement-breakpoint
WITH demand_source AS (
	SELECT
		'pdemand_' || l.id AS id,
		po.tenant_id,
		po.platform_store_id,
		po.id AS order_id,
		l.id AS order_line_id,
		po.platform,
		po.source_order_id,
		l.source_order_line_id,
		l.raw_sku,
		l.normalized_sku,
		CASE
			WHEN l.mapping_status = 'mapped' AND l.mapped_sku_id IS NOT NULL THEN l.mapped_sku_id
			WHEN pm.status = 'mapped' AND pm.sku_id IS NOT NULL THEN pm.sku_id
			ELSE NULL
		END AS effective_sku_id,
		CASE
			WHEN (l.mapping_status = 'mapped' AND l.mapped_sku_id IS NOT NULL)
				OR (pm.status = 'mapped' AND pm.sku_id IS NOT NULL) THEN 'mapped'
			WHEN l.mapping_status = 'ambiguous' OR pm.status = 'ambiguous' THEN 'ambiguous'
			ELSE 'unmapped'
		END AS effective_mapping_status,
		l.ordered_quantity,
		l.current_quantity,
		l.unfulfilled_quantity,
		CASE
			WHEN l.current_quantity IS NOT NULL AND l.unfulfilled_quantity IS NOT NULL
				THEN MAX(0, MIN(l.current_quantity, l.unfulfilled_quantity))
			ELSE MAX(0, COALESCE(l.unfulfilled_quantity, l.current_quantity, l.ordered_quantity, 0))
		END AS candidate_quantity,
		l.is_current,
		po.test,
		po.source_cancelled_at,
		po.fulfillment_status,
		po.source_updated_at,
		l.first_seen_at,
		po.last_seen_at
	FROM platform_order_lines l
	JOIN platform_orders po
		ON po.id = l.order_id AND po.tenant_id = l.tenant_id
	LEFT JOIN platform_sku_mappings pm
		ON pm.tenant_id = l.tenant_id
		AND pm.platform_store_id = po.platform_store_id
		AND pm.raw_sku = l.raw_sku
)
INSERT INTO purchase_demands (
	id, tenant_id, platform_store_id, order_id, order_line_id, platform,
	source_order_id, source_order_line_id, raw_sku, normalized_sku, mapped_sku_id,
	status, ordered_quantity, current_quantity, unfulfilled_quantity, required_quantity,
	reason_code, source_updated_at, first_seen_at, last_refreshed_at, updated_at
)
SELECT
	id, tenant_id, platform_store_id, order_id, order_line_id, platform,
	source_order_id, source_order_line_id, raw_sku, normalized_sku, effective_sku_id,
	CASE
		WHEN is_current = 0 OR test = 1 OR source_cancelled_at IS NOT NULL
			OR UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
			OR candidate_quantity <= 0 THEN 'not_required'
		WHEN effective_sku_id IS NULL OR effective_mapping_status <> 'mapped' THEN 'needs_mapping'
		ELSE 'open'
	END,
	ordered_quantity, current_quantity, unfulfilled_quantity,
	CASE
		WHEN is_current = 0 OR test = 1 OR source_cancelled_at IS NOT NULL
			OR UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
			OR candidate_quantity <= 0 THEN 0
		ELSE candidate_quantity
	END,
	CASE
		WHEN is_current = 0 THEN 'line_removed'
		WHEN test = 1 THEN 'test_order'
		WHEN source_cancelled_at IS NOT NULL THEN 'cancelled_order'
		WHEN UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED' THEN 'fulfilled_order'
		WHEN candidate_quantity <= 0 THEN 'no_unfulfilled_quantity'
		WHEN effective_sku_id IS NULL AND (raw_sku IS NULL OR TRIM(raw_sku) = '') THEN 'sku_missing'
		WHEN effective_mapping_status = 'ambiguous' THEN 'sku_ambiguous'
		WHEN effective_sku_id IS NULL OR effective_mapping_status <> 'mapped' THEN 'sku_unmapped'
		ELSE NULL
	END,
	source_updated_at, first_seen_at, last_seen_at, last_seen_at
FROM demand_source;
