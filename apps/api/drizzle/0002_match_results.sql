CREATE TABLE "match_players" (
	"match_id" text NOT NULL,
	"user_id" text NOT NULL,
	"placement" smallint NOT NULL,
	"score" integer NOT NULL,
	"kills" integer NOT NULL,
	"deaths" integer NOT NULL,
	"assists" integer NOT NULL,
	"damage" integer NOT NULL,
	"damage_taken" integer NOT NULL,
	"headshots" integer NOT NULL,
	"best_streak" integer NOT NULL,
	"left" boolean NOT NULL,
	"mvp" boolean NOT NULL,
	"xp_gained" integer NOT NULL,
	CONSTRAINT "match_players_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"map" text NOT NULL,
	"room" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_s" integer NOT NULL,
	"server_build" text NOT NULL,
	"result" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_lifetime" (
	"user_id" text NOT NULL,
	"weapon_id" text NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"assists" integer DEFAULT 0 NOT NULL,
	"damage" integer DEFAULT 0 NOT NULL,
	"headshots" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"playtime_s" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stats_lifetime_user_id_weapon_id_pk" PRIMARY KEY("user_id","weapon_id")
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_lifetime" ADD CONSTRAINT "stats_lifetime_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_players_user_id_idx" ON "match_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "matches_ended_at_idx" ON "matches" USING btree ("ended_at");