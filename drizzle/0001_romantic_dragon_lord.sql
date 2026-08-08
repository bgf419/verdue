DROP INDEX `idx_user_claims_user_case`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_claims_user_case` ON `user_claims` (`user_id`,`case_id`);