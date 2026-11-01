CREATE TABLE "friend_request_declines" (
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "friend_request_declines_from_id_to_id_pk" PRIMARY KEY("from_id","to_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"reason" text NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"room" text,
	"place" text,
	"created_at" timestamp with time zone NOT NULL,
	"handled_at" timestamp with time zone,
	"action" text,
	CONSTRAINT "player_reports_reason_check" CHECK ("player_reports"."reason" in ('name', 'voice', 'cheating', 'spam', 'underage', 'other'))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "requests_from" text DEFAULT 'anyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "minor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "friend_request_declines" ADD CONSTRAINT "friend_request_declines_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_request_declines" ADD CONSTRAINT "friend_request_declines_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_request_declines_at_idx" ON "friend_request_declines" USING btree ("at");--> statement-breakpoint
CREATE INDEX "moderation_audit_user_id_idx" ON "moderation_audit" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "moderation_audit_at_idx" ON "moderation_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "player_reports_created_at_idx" ON "player_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "player_reports_target_id_idx" ON "player_reports" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "player_reports_reporter_target_idx" ON "player_reports" USING btree ("reporter_id","target_id","created_at");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_requests_from_check" CHECK ("profiles"."requests_from" in ('anyone', 'played', 'code'));