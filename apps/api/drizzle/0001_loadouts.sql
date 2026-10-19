CREATE TABLE "loadouts" (
	"user_id" text NOT NULL,
	"slot" smallint NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "loadouts_user_id_slot_pk" PRIMARY KEY("user_id","slot"),
	CONSTRAINT "loadouts_slot_check" CHECK ("loadouts"."slot" between 0 and 2)
);
--> statement-breakpoint
ALTER TABLE "loadouts" ADD CONSTRAINT "loadouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;