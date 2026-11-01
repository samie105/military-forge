ALTER TABLE "profiles" ADD COLUMN "appear_offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "online_to_recent" boolean DEFAULT false NOT NULL;