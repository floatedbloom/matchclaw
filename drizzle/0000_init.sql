CREATE TABLE `agents` (
	`pubkey` text PRIMARY KEY NOT NULL,
	`agent_card_url` text NOT NULL,
	`contact_type` text NOT NULL,
	`contact_value_enc` text NOT NULL,
	`last_seen` integer NOT NULL,
	`registered_at` integer NOT NULL,
	`protocol_version` text DEFAULT '1.0' NOT NULL,
	`geo_query` text,
	`geo_lat` real,
	`geo_lng` real,
	`geo_resolution` text,
	`geo_label` text,
	`geo_anywhere` integer NOT NULL DEFAULT 0,
	`max_distance_km` real
);
