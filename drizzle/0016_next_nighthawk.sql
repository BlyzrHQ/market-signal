CREATE TABLE IF NOT EXISTS `billing_report_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `billing_report_reservations_run_uidx` ON `billing_report_reservations` (`run_id`) WHERE "billing_report_reservations"."run_id" != '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `billing_report_reservations_usage_idx` ON `billing_report_reservations` (`workspace_id`,`period_start`,`period_end`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_tombstone` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_audit_log_workspace_idx` ON `price_watch_audit_log` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_credit_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`watcher_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`due_slot` text NOT NULL,
	`status` text NOT NULL,
	`claim_owner` text DEFAULT '' NOT NULL,
	`lease_expires_at` text DEFAULT '' NOT NULL,
	`external_attempt_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_watch_credit_reservations_status_check" CHECK("price_watch_credit_reservations"."status" in ('reserved', 'attempting', 'committed', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watch_credit_reservations_due_uidx` ON `price_watch_credit_reservations` (`watcher_id`,`due_slot`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_credit_reservations_usage_idx` ON `price_watch_credit_reservations` (`workspace_id`,`period_start`,`period_end`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_credit_reservations_lease_idx` ON `price_watch_credit_reservations` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_email_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`watcher_id` text NOT NULL,
	`recipient_user_id` text,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`batch_after` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text DEFAULT '' NOT NULL,
	`delivered_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`event_id`) REFERENCES `price_watch_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_watch_email_outbox_status_check" CHECK("price_watch_email_outbox"."status" in ('pending', 'sending', 'delivered')),
	CONSTRAINT "price_watch_email_outbox_attempt_count_check" CHECK("price_watch_email_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watch_email_outbox_event_uidx` ON `price_watch_email_outbox` (`event_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_email_outbox_due_idx` ON `price_watch_email_outbox` (`status`,`batch_after`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_entitlements` (
	`workspace_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`plan_tier` text NOT NULL,
	`allocation` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `period_start`, `period_end`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_watch_entitlements_allocation_check" CHECK("price_watch_entitlements"."allocation" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_entitlements_period_idx` ON `price_watch_entitlements` (`period_start`,`period_end`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`watcher_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watch_events_idempotency_uidx` ON `price_watch_events` (`watcher_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_events_history_idx` ON `price_watch_events` (`watcher_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watch_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`watcher_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`raw_price` text NOT NULL,
	`list_amount_micros` integer,
	`raw_list_price` text DEFAULT '' NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reservation_id`) REFERENCES `price_watch_credit_reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_watch_observations_amount_check" CHECK("price_watch_observations"."amount_micros" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watch_observations_reservation_uidx` ON `price_watch_observations` (`reservation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watch_observations_history_idx` ON `price_watch_observations` (`watcher_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watcher_report_links` (
	`watcher_id` text NOT NULL,
	`report_run_id` text NOT NULL,
	`match_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`watcher_id`, `report_run_id`, `match_id`),
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`match_id`) REFERENCES `report_matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watcher_report_links_report_idx` ON `price_watcher_report_links` (`report_run_id`,`match_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`resolved_url` text DEFAULT '' NOT NULL,
	`canonicalization_version` integer NOT NULL,
	`source_domain` text NOT NULL,
	`rival_domain` text NOT NULL,
	`product_name` text NOT NULL,
	`variant_key` text NOT NULL,
	`variant_json` text NOT NULL,
	`audit_target` text NOT NULL,
	`creator_user_id` text,
	`email_owner_user_id` text,
	`cadence` text NOT NULL,
	`state` text NOT NULL,
	`pause_reason` text DEFAULT '' NOT NULL,
	`baseline_currency` text DEFAULT '' NOT NULL,
	`baseline_amount_micros` integer,
	`baseline_raw` text DEFAULT '' NOT NULL,
	`baseline_list_amount_micros` integer,
	`baseline_list_raw` text DEFAULT '' NOT NULL,
	`baseline_observed_at` text DEFAULT '' NOT NULL,
	`failure_streak` integer DEFAULT 0 NOT NULL,
	`next_check_at` text DEFAULT '' NOT NULL,
	`last_check_at` text DEFAULT '' NOT NULL,
	`claim_owner` text DEFAULT '' NOT NULL,
	`claim_expires_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`email_owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "price_watchers_cadence_check" CHECK("price_watchers"."cadence" in ('hourly', 'daily')),
	CONSTRAINT "price_watchers_state_check" CHECK("price_watchers"."state" in ('baseline_pending', 'active', 'disabled', 'paused_credits', 'paused_subscription', 'paused_failure')),
	CONSTRAINT "price_watchers_failure_streak_check" CHECK("price_watchers"."failure_streak" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watchers_audit_target_unique` ON `price_watchers` (`audit_target`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `price_watchers_target_uidx` ON `price_watchers` (`workspace_id`,`canonical_url`,`variant_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watchers_due_idx` ON `price_watchers` (`state`,`next_check_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `price_watchers_workspace_idx` ON `price_watchers` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stripe_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`event_created` integer NOT NULL,
	`processed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_notification_reads` (
	`notification_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`notification_id`, `user_id`),
	FOREIGN KEY (`notification_id`) REFERENCES `workspace_notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_notification_reads_user_idx` ON `workspace_notification_reads` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`watcher_id` text,
	`notification_type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`watcher_id`) REFERENCES `price_watchers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_notifications_dedupe_uidx` ON `workspace_notifications` (`workspace_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_notifications_recent_idx` ON `workspace_notifications` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_subscriptions` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text DEFAULT '' NOT NULL,
	`stripe_price_id` text DEFAULT '' NOT NULL,
	`plan_tier` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'incomplete' NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`current_period_start` text DEFAULT '' NOT NULL,
	`current_period_end` text DEFAULT '' NOT NULL,
	`last_event_created` integer DEFAULT 0 NOT NULL,
	`last_event_id` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_subscriptions_stripe_customer_id_unique` ON `workspace_subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_subscriptions_subscription_uidx` ON `workspace_subscriptions` (`stripe_subscription_id`) WHERE "workspace_subscriptions"."stripe_subscription_id" != '';--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `price_watch_audit_log_no_update`
BEFORE UPDATE ON `price_watch_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'price-watch audit rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `price_watch_audit_log_no_direct_delete`
BEFORE DELETE ON `price_watch_audit_log`
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
BEGIN
	SELECT RAISE(ABORT, 'price-watch audit rows are immutable');
END;
