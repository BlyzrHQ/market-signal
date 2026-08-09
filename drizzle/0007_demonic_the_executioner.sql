PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_report_evaluations` (
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
	`cost_microusd` integer,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`output_tokens` integer,
	`usage_status` text DEFAULT 'not_called' NOT NULL,
	`reserved_cost_microusd` integer DEFAULT 0 NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`deterministic_at` text DEFAULT '' NOT NULL,
	`dispatch_started_at` text DEFAULT '' NOT NULL,
	`dispatch_failed_at` text DEFAULT '' NOT NULL,
	`watchdog_expired_at` text DEFAULT '' NOT NULL,
	`reservation_id` text DEFAULT '' NOT NULL,
	`reservation_owner` text DEFAULT '' NOT NULL,
	`reserved_at` text DEFAULT '' NOT NULL,
	`client_request_id` text DEFAULT '' NOT NULL,
	`provider_response_id` text DEFAULT '' NOT NULL,
	`provider_request_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_report_evaluations`("id", "run_id", "evaluation_type", "input_hash", "fact_manifest_hash", "evaluator_version", "rubric_version", "status", "rating_basis", "overall_score", "user_value_score", "evidence_integrity_score", "evidence_yield_score", "presentation_score", "deterministic_score", "grade", "deterministic_json", "agent_json", "findings_json", "proposals_json", "model", "prompt_version", "pricing_version", "cost_microusd", "input_tokens", "cached_input_tokens", "output_tokens", "usage_status", "reserved_cost_microusd", "error_code", "dispatch_attempts", "deterministic_at", "dispatch_started_at", "dispatch_failed_at", "watchdog_expired_at", "reservation_id", "reservation_owner", "reserved_at", "client_request_id", "provider_response_id", "provider_request_id", "created_at", "started_at", "completed_at") SELECT "id", "run_id", "evaluation_type", "input_hash", "fact_manifest_hash", "evaluator_version", "rubric_version", "status", "rating_basis", "overall_score", "user_value_score", "evidence_integrity_score", "evidence_yield_score", "presentation_score", "deterministic_score", "grade", "deterministic_json", "agent_json", "findings_json", "proposals_json", "model", "prompt_version", "pricing_version", CASE WHEN COALESCE("cost_microusd", 0) > 0 OR COALESCE("input_tokens", 0) > 0 OR COALESCE("output_tokens", 0) > 0 THEN "cost_microusd" ELSE NULL END, CASE WHEN COALESCE("cost_microusd", 0) > 0 OR COALESCE("input_tokens", 0) > 0 OR COALESCE("output_tokens", 0) > 0 THEN "input_tokens" ELSE NULL END, CASE WHEN COALESCE("cost_microusd", 0) > 0 OR COALESCE("input_tokens", 0) > 0 OR COALESCE("output_tokens", 0) > 0 THEN 0 ELSE NULL END, CASE WHEN COALESCE("cost_microusd", 0) > 0 OR COALESCE("input_tokens", 0) > 0 OR COALESCE("output_tokens", 0) > 0 THEN "output_tokens" ELSE NULL END, CASE WHEN COALESCE("cost_microusd", 0) > 0 OR COALESCE("input_tokens", 0) > 0 OR COALESCE("output_tokens", 0) > 0 THEN 'known' ELSE 'not_called' END, 0, "error_code", "dispatch_attempts", CASE WHEN "status" IN ('deterministic', 'rubric_unavailable', 'failed') THEN COALESCE(NULLIF("completed_at", ''), "created_at") ELSE '' END, '', '', '', '', '', '', '', '', '', "created_at", "started_at", "completed_at" FROM `report_evaluations`;--> statement-breakpoint
DROP TABLE `report_evaluations`;--> statement-breakpoint
ALTER TABLE `__new_report_evaluations` RENAME TO `report_evaluations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluations_identity_uidx` ON `report_evaluations` (`run_id`,`input_hash`,`evaluator_version`,`evaluation_type`);--> statement-breakpoint
CREATE INDEX `report_evaluations_run_completed_idx` ON `report_evaluations` (`run_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `report_evaluations_score_completed_idx` ON `report_evaluations` (`overall_score`,`completed_at`);--> statement-breakpoint
CREATE INDEX `report_evaluations_status_completed_idx` ON `report_evaluations` (`status`,`completed_at`);
