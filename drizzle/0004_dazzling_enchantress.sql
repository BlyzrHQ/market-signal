CREATE TABLE IF NOT EXISTS `report_match_batch_checkpoints` (
	`run_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`batch_index` integer NOT NULL,
	`input_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`result_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `attempt_number`, `batch_index`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_match_batch_checkpoints_run_attempt_idx` ON `report_match_batch_checkpoints` (`run_id`,`attempt_number`,`batch_index`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_purge_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`cutoff` text NOT NULL,
	`heartbeat_guard` text NOT NULL,
	`runs_deleted` integer NOT NULL,
	`quality_signals_deleted` integer NOT NULL,
	`evaluations_deleted` integer NOT NULL,
	`ads_deleted` integer NOT NULL,
	`matches_deleted` integer NOT NULL,
	`products_deleted` integer NOT NULL,
	`companies_deleted` integer NOT NULL,
	`fact_chunks_deleted` integer NOT NULL,
	`fact_manifests_deleted` integer NOT NULL,
	`documents_deleted` integer NOT NULL,
	`events_deleted` integer NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_purge_audits_observed_idx` ON `report_purge_audits` (`observed_at`);
