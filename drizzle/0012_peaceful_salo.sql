ALTER TABLE `report_evaluation_feedback_claims` ADD `payload_hash` text NOT NULL CHECK (length(`payload_hash`) = 64);
