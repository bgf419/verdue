CREATE TABLE `case_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` text NOT NULL,
	`event_type` text NOT NULL,
	`happened_at` text NOT NULL,
	`label` text NOT NULL,
	`source_url` text NOT NULL,
	`verification_state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_case_events_case_happened` ON `case_events` (`case_id`,`happened_at`);--> statement-breakpoint
CREATE TABLE `case_records` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`defendant` text NOT NULL,
	`action_type` text NOT NULL,
	`category` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`court` text,
	`docket_number` text,
	`filed_at` text,
	`case_stage` text NOT NULL,
	`claim_window` text NOT NULL,
	`claim_deadline` text,
	`official_url` text NOT NULL,
	`claim_url` text,
	`source_updated_at` text,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_case_records_window_deadline` ON `case_records` (`claim_window`,`claim_deadline`);--> statement-breakpoint
CREATE INDEX `idx_case_records_stage_category` ON `case_records` (`case_stage`,`category`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_claim_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_claim_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`provenance` text NOT NULL,
	`happened_at` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `idx_user_claim_events_claim_happened` ON `user_claim_events` (`user_claim_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `idx_user_claim_events_user` ON `user_claim_events` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`case_id` text NOT NULL,
	`personal_status` text NOT NULL,
	`status_provenance` text NOT NULL,
	`confirmation_number` text,
	`submitted_at` text,
	`approved_amount_cents` integer,
	`received_amount_cents` integer,
	`amount_source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_user_claims_user_status` ON `user_claims` (`user_id`,`personal_status`);--> statement-breakpoint
CREATE INDEX `idx_user_claims_user_case` ON `user_claims` (`user_id`,`case_id`);