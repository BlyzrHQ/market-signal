CREATE TABLE `report_evaluation_feedback_claims` (
	`outbox_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`consumer_key` text NOT NULL,
	`lease_id_hash` text NOT NULL CHECK (length(`lease_id_hash`) = 64),
	`leased_until` text NOT NULL,
	`claimed_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `report_evaluation_feedback_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_evaluation_feedback_outbox` (
	`queue_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`event_kind` text DEFAULT 'terminal_report_evaluation' NOT NULL CHECK (`event_kind` = 'terminal_report_evaluation'),
	`created_at` text NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `report_evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluation_feedback_outbox_id_uidx` ON `report_evaluation_feedback_outbox` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluation_feedback_outbox_evaluation_uidx` ON `report_evaluation_feedback_outbox` (`evaluation_id`);--> statement-breakpoint
CREATE INDEX `report_evaluation_feedback_claims_expiry_idx` ON `report_evaluation_feedback_claims` (`leased_until`);--> statement-breakpoint
CREATE TABLE `report_evaluation_feedback_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`outbox_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`consumer_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_hash` text NOT NULL CHECK (length(`payload_hash`) = 64),
	`receipt_hash` text NOT NULL CHECK (length(`receipt_hash`) = 64),
	`acknowledged_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `report_evaluation_feedback_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `report_evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluation_feedback_receipts_outbox_uidx` ON `report_evaluation_feedback_receipts` (`outbox_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluation_feedback_receipts_idempotency_uidx` ON `report_evaluation_feedback_receipts` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `evaluation_feedback_outbox_deleted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `evaluation_feedback_claims_deleted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `evaluation_feedback_receipts_deleted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `report_evaluation_feedback_outbox_immutable` BEFORE UPDATE ON `report_evaluation_feedback_outbox` BEGIN SELECT RAISE(ABORT, 'immutable evaluation feedback outbox'); END;--> statement-breakpoint
CREATE TRIGGER `report_evaluation_feedback_receipts_immutable` BEFORE UPDATE ON `report_evaluation_feedback_receipts` BEGIN SELECT RAISE(ABORT, 'immutable evaluation feedback receipt'); END;--> statement-breakpoint
CREATE TRIGGER `report_evaluations_terminal_immutable` BEFORE UPDATE ON `report_evaluations` WHEN OLD.status IN ('complete','agent_rejected','needs_human_review','call_outcome_unknown','insufficient_facts','rubric_unavailable','failed') BEGIN SELECT RAISE(ABORT, 'immutable terminal report evaluation'); END;--> statement-breakpoint
CREATE TRIGGER `report_evaluations_terminal_outbox_update` AFTER UPDATE OF status ON `report_evaluations` WHEN NEW.status IN ('complete','agent_rejected','needs_human_review','call_outcome_unknown','insufficient_facts','rubric_unavailable','failed') AND OLD.status != NEW.status BEGIN INSERT INTO `report_evaluation_feedback_outbox` (`id`, `evaluation_id`, `run_id`, `event_kind`, `created_at`) VALUES (lower(hex(randomblob(16))), NEW.id, NEW.run_id, 'terminal_report_evaluation', CASE WHEN NEW.completed_at != '' THEN NEW.completed_at ELSE NEW.created_at END); END;--> statement-breakpoint
CREATE TRIGGER `report_evaluations_terminal_outbox_insert` AFTER INSERT ON `report_evaluations` WHEN NEW.status IN ('complete','agent_rejected','needs_human_review','call_outcome_unknown','insufficient_facts','rubric_unavailable','failed') BEGIN INSERT INTO `report_evaluation_feedback_outbox` (`id`, `evaluation_id`, `run_id`, `event_kind`, `created_at`) VALUES (lower(hex(randomblob(16))), NEW.id, NEW.run_id, 'terminal_report_evaluation', CASE WHEN NEW.completed_at != '' THEN NEW.completed_at ELSE NEW.created_at END); END;
