CREATE TABLE `report_human_review_open` (
	`request_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`queue_seq` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `report_human_review_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_open_queue_uidx` ON `report_human_review_open` (`queue_seq`);--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `human_review_open_deleted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_report_human_review_requests` (
	`queue_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`evaluator_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`fact_manifest_hash` text NOT NULL,
	`uncertainty_code` text NOT NULL CHECK (`uncertainty_code` IN ('conflicting_evidence','subjective_usefulness','insufficient_context','suspected_factual_error')),
	`question` text NOT NULL CHECK (length(`question`) BETWEEN 1 AND 240),
	`evidence_ids_json` text NOT NULL,
	`request_hash` text NOT NULL CHECK (length(`request_hash`) = 64),
	`created_at` text NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `report_evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_report_human_review_requests`("queue_seq", "id", "evaluation_id", "run_id", "evaluator_version", "input_hash", "fact_manifest_hash", "uncertainty_code", "question", "evidence_ids_json", "request_hash", "created_at") SELECT "queue_seq", "id", "evaluation_id", "run_id", "evaluator_version", "input_hash", "fact_manifest_hash", "uncertainty_code", "question", "evidence_ids_json", "request_hash", "created_at" FROM `report_human_review_requests`;--> statement-breakpoint
DROP TABLE `report_human_review_requests`;--> statement-breakpoint
ALTER TABLE `__new_report_human_review_requests` RENAME TO `report_human_review_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_requests_id_uidx` ON `report_human_review_requests` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_requests_evaluation_uidx` ON `report_human_review_requests` (`evaluation_id`);--> statement-breakpoint
CREATE TABLE `__new_report_human_review_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`resolution_code` text NOT NULL CHECK (`resolution_code` IN ('answered','unable_to_determine','invalid_question')),
	`answer_text` text DEFAULT '' NOT NULL CHECK ((`resolution_code` = 'answered' AND length(`answer_text`) BETWEEN 1 AND 1000) OR (`resolution_code` != 'answered' AND `answer_text` = '')),
	`response_hash` text NOT NULL CHECK (length(`response_hash`) = 64),
	`reviewer_key` text NOT NULL,
	`responded_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `report_human_review_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `report_evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_report_human_review_responses`("id", "request_id", "evaluation_id", "run_id", "idempotency_key", "resolution_code", "answer_text", "response_hash", "reviewer_key", "responded_at") SELECT "id", "request_id", "evaluation_id", "run_id", "idempotency_key", "resolution_code", "answer_text", "response_hash", "reviewer_key", "responded_at" FROM `report_human_review_responses`;--> statement-breakpoint
DROP TABLE `report_human_review_responses`;--> statement-breakpoint
ALTER TABLE `__new_report_human_review_responses` RENAME TO `report_human_review_responses`;--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_responses_request_uidx` ON `report_human_review_responses` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_human_review_responses_idempotency_uidx` ON `report_human_review_responses` (`idempotency_key`);
--> statement-breakpoint
CREATE TRIGGER `report_human_review_requests_immutable` BEFORE UPDATE ON `report_human_review_requests` BEGIN SELECT RAISE(ABORT, 'immutable human review request'); END;
--> statement-breakpoint
CREATE TRIGGER `report_human_review_responses_immutable` BEFORE UPDATE ON `report_human_review_responses` BEGIN SELECT RAISE(ABORT, 'immutable human review response'); END;
