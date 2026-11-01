CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"author_id" text,
	"subject_id" text,
	"quick" text,
	"body" text,
	"card" jsonb,
	"reply_to" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "chat_messages_kind_check" CHECK ("chat_messages"."kind" in ('chat', 'room_posted', 'match_result', 'welcome', 'level_up'))
);
--> statement-breakpoint
CREATE TABLE "chat_mutes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_reports" ADD COLUMN "message_id" bigint;--> statement-breakpoint
ALTER TABLE "player_reports" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_rules_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_mutes" ADD CONSTRAINT "chat_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_author_id_idx" ON "chat_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "chat_messages_subject_id_idx" ON "chat_messages" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "player_reports_message_id_idx" ON "player_reports" USING btree ("message_id");