CREATE TABLE `report_fact_chunks` (
	`run_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`kind` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`item_count` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `manifest_id`, `kind`, `chunk_index`)
);
--> statement-breakpoint
CREATE INDEX `report_fact_chunks_run_manifest_idx` ON `report_fact_chunks` (`run_id`,`manifest_id`);--> statement-breakpoint
CREATE TABLE `report_fact_manifests` (
	`run_id` text PRIMARY KEY NOT NULL,
	`manifest_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`company_count` integer NOT NULL,
	`product_count` integer NOT NULL,
	`match_count` integer NOT NULL,
	`ad_count` integer NOT NULL,
	`status` text NOT NULL,
	`lock_owner` text NOT NULL,
	`locked_at` text NOT NULL,
	`completed_at` text NOT NULL
);
