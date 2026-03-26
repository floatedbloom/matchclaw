CREATE TABLE `negotiations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`pubkey_low` text NOT NULL,
	`pubkey_high` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
