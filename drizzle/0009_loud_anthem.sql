CREATE TABLE `report_human_review_requests` (
	`queue_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`evaluator_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`fact_manifest_hash` text NOT NULL,
	`uncertainty_code` text NOT NULL,
	`question` text NOT NULL,
	`evidence_ids_json` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_requests_id_uidx` ON `report_human_review_requests` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_requests_evaluation_uidx` ON `report_human_review_requests` (`evaluation_id`);--> statement-breakpoint
CREATE TABLE `report_human_review_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`resolution_code` text NOT NULL,
	`answer_text` text DEFAULT '' NOT NULL,
	`response_hash` text NOT NULL,
	`reviewer_key` text NOT NULL,
	`responded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_responses_request_uidx` ON `report_human_review_responses` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_responses_idempotency_uidx` ON `report_human_review_responses` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `human_review_requests_deleted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `human_review_responses_deleted` integer DEFAULT 0 NOT NULL;