CREATE TABLE `report_ads` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`domain` text NOT NULL,
	`platform` text NOT NULL,
	`status` text NOT NULL,
	`evidence_json` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `report_ads_run_domain_idx` ON `report_ads` (`run_id`,`domain`);--> statement-breakpoint
CREATE TABLE `report_companies` (
	`run_id` text NOT NULL,
	`domain` text NOT NULL,
	`role` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`evidence_url` text DEFAULT '' NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `domain`)
);
--> statement-breakpoint
CREATE INDEX `report_companies_run_role_idx` ON `report_companies` (`run_id`,`role`);--> statement-breakpoint
CREATE TABLE `report_documents` (
	`run_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`document_json` text NOT NULL,
	`observed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_events_run_sequence_uidx` ON `report_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_events_run_idempotency_uidx` ON `report_events` (`run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `report_events_run_order_idx` ON `report_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `report_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`primary_product_id` text NOT NULL,
	`rival_product_id` text NOT NULL,
	`rival_domain` text NOT NULL,
	`verdict` text NOT NULL,
	`confidence` text NOT NULL,
	`claim_type` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`prompt_version` text DEFAULT '' NOT NULL,
	`evidence_json` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `report_matches_run_rival_idx` ON `report_matches` (`run_id`,`rival_domain`);--> statement-breakpoint
CREATE TABLE `report_products` (
	`run_id` text NOT NULL,
	`domain` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text DEFAULT '' NOT NULL,
	`source_url` text NOT NULL,
	`image_url` text DEFAULT '' NOT NULL,
	`price_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `domain`, `product_id`)
);
--> statement-breakpoint
CREATE INDEX `report_products_run_domain_idx` ON `report_products` (`run_id`,`domain`);--> statement-breakpoint
CREATE TABLE `report_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`primary_domain` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`status` text NOT NULL,
	`current_phase` text NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`error_message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_runs_public_id_uidx` ON `report_runs` (`public_id`);--> statement-breakpoint
CREATE INDEX `report_runs_domain_recent_idx` ON `report_runs` (`primary_domain`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_runs_expiry_idx` ON `report_runs` (`expires_at`);