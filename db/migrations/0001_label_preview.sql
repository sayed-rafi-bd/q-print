CREATE TABLE `label_preview` (
	`user_id` text NOT NULL,
	`label_id` text NOT NULL,
	`values_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `label_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `label_preview_by_user` ON `label_preview` (`user_id`);