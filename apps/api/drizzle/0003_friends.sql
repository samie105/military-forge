CREATE TABLE "blocks" (
	"user_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "blocks_user_id_blocked_id_pk" PRIMARY KEY("user_id","blocked_id"),
	CONSTRAINT "blocks_not_self" CHECK ("blocks"."user_id" <> "blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "friend_requests_from_id_to_id_pk" PRIMARY KEY("from_id","to_id"),
	CONSTRAINT "friend_requests_not_self" CHECK ("friend_requests"."from_id" <> "friend_requests"."to_id")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_id" text NOT NULL,
	"friend_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "friendships_user_id_friend_id_pk" PRIMARY KEY("user_id","friend_id"),
	CONSTRAINT "friendships_not_self" CHECK ("friendships"."user_id" <> "friendships"."friend_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "friend_code" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_id_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "friend_requests_to_id_idx" ON "friend_requests" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "friendships_friend_id_idx" ON "friendships" USING btree ("friend_id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_friend_code_unique" UNIQUE("friend_code");