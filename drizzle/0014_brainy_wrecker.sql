CREATE TABLE `report_runtime_schema_markers` (
	`key` text PRIMARY KEY NOT NULL,
	`completed_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `report_runtime_schema_markers` (`key`, `completed_at`) VALUES ('evaluation-feedback-pending-backfill-v1', CURRENT_TIMESTAMP);
