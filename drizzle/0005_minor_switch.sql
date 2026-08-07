CREATE TABLE `report_product_entitlements` (
	`run_id` text PRIMARY KEY NOT NULL,
	`plan_tier` text NOT NULL,
	`product_limit` integer NOT NULL,
	`resolved_at` text NOT NULL
);
