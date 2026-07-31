CREATE TABLE `report_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`evaluation_type` text NOT NULL,
	`input_hash` text NOT NULL,
	`fact_manifest_hash` text DEFAULT '' NOT NULL,
	`evaluator_version` text NOT NULL,
	`rubric_version` text NOT NULL,
	`status` text NOT NULL,
	`rating_basis` text NOT NULL,
	`overall_score` integer,
	`user_value_score` integer,
	`evidence_integrity_score` integer,
	`evidence_yield_score` integer,
	`presentation_score` integer,
	`deterministic_score` integer,
	`grade` text,
	`deterministic_json` text DEFAULT '{}' NOT NULL,
	`agent_json` text DEFAULT '{}' NOT NULL,
	`findings_json` text DEFAULT '[]' NOT NULL,
	`proposals_json` text DEFAULT '[]' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`prompt_version` text DEFAULT '' NOT NULL,
	`pricing_version` text DEFAULT '' NOT NULL,
	`cost_microusd` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluations_identity_uidx` ON `report_evaluations` (`run_id`,`input_hash`,`evaluator_version`,`evaluation_type`);--> statement-breakpoint
CREATE INDEX `report_evaluations_run_completed_idx` ON `report_evaluations` (`run_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `report_evaluations_score_completed_idx` ON `report_evaluations` (`overall_score`,`completed_at`);--> statement-breakpoint
CREATE INDEX `report_evaluations_status_completed_idx` ON `report_evaluations` (`status`,`completed_at`);--> statement-breakpoint
CREATE TABLE `report_quality_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`primary_domain` text NOT NULL,
	`stage` text NOT NULL,
	`issue_key` text NOT NULL,
	`severity` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_quality_signals_evaluation_issue_uidx` ON `report_quality_signals` (`evaluation_id`,`issue_key`);--> statement-breakpoint
CREATE INDEX `report_quality_signals_issue_observed_idx` ON `report_quality_signals` (`issue_key`,`observed_at`);--> statement-breakpoint
CREATE INDEX `report_quality_signals_stage_severity_observed_idx` ON `report_quality_signals` (`stage`,`severity`,`observed_at`);