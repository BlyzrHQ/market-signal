CREATE TABLE IF NOT EXISTS `report_share_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`rotation` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "report_share_audits_action_check" CHECK("report_share_audits"."action" IN ('share', 'unshare')),
	CONSTRAINT "report_share_audits_rotation_check" CHECK("report_share_audits"."rotation" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_share_audits_run_idx` ON `report_share_audits` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_share_audits_workspace_idx` ON `report_share_audits` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `report_share_audits_no_update`
	BEFORE UPDATE ON `report_share_audits`
	BEGIN SELECT RAISE(ABORT, 'report share audit rows are immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `report_share_audits_no_direct_delete`
	BEFORE DELETE ON `report_share_audits`
	WHEN EXISTS (SELECT 1 FROM `report_runs` WHERE `id` = OLD.`run_id`)
	BEGIN SELECT RAISE(ABORT, 'report share audit rows are immutable'); END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_share_links` (
	`run_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`rotation` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "report_share_links_token_check" CHECK(length("report_share_links"."token") = 64 AND "report_share_links"."token" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "report_share_links_active_check" CHECK("report_share_links"."active" IN (0, 1)),
	CONSTRAINT "report_share_links_rotation_check" CHECK("report_share_links"."rotation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `report_share_links_token_uidx` ON `report_share_links` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_share_links_active_idx` ON `report_share_links` (`active`,`updated_at`);
