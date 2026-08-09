CREATE TABLE `report_evaluation_feedback_pending` (
	`outbox_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`queue_seq` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `report_evaluation_feedback_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_evaluation_feedback_pending_queue_uidx` ON `report_evaluation_feedback_pending` (`queue_seq`);--> statement-breakpoint
INSERT INTO `report_evaluation_feedback_pending` (`outbox_id`, `run_id`, `queue_seq`, `created_at`) SELECT outbox.id, outbox.run_id, outbox.queue_seq, outbox.created_at FROM `report_evaluation_feedback_outbox` outbox LEFT JOIN `report_evaluation_feedback_receipts` receipts ON receipts.outbox_id = outbox.id WHERE receipts.outbox_id IS NULL;--> statement-breakpoint
CREATE TRIGGER `report_evaluation_feedback_outbox_pending_insert` AFTER INSERT ON `report_evaluation_feedback_outbox` BEGIN INSERT INTO `report_evaluation_feedback_pending` (`outbox_id`, `run_id`, `queue_seq`, `created_at`) VALUES (NEW.id, NEW.run_id, NEW.queue_seq, NEW.created_at); END;--> statement-breakpoint
CREATE TRIGGER `report_evaluation_feedback_receipt_pending_delete` AFTER INSERT ON `report_evaluation_feedback_receipts` BEGIN DELETE FROM `report_evaluation_feedback_pending` WHERE outbox_id = NEW.outbox_id; END;--> statement-breakpoint
ALTER TABLE `report_purge_audits` ADD `evaluation_feedback_pending_deleted` integer DEFAULT 0 NOT NULL;
