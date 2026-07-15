CREATE TABLE `verified_competitors` (
	`primary_domain` text NOT NULL,
	`competitor_domain` text NOT NULL,
	`candidate_json` text NOT NULL,
	`first_verified_at` text NOT NULL,
	`last_verified_at` text NOT NULL,
	`last_verification_score` integer NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`evidence_url` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`primary_domain`, `competitor_domain`)
);
--> statement-breakpoint
CREATE INDEX `verified_competitors_primary_recent_idx` ON `verified_competitors` (`primary_domain`,`last_verified_at`);