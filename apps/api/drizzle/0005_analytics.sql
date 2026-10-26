-- Play stats (docs/16-player-metrics.md §4). Written by hand: Drizzle can't declare a partitioned
-- table. src/db/analytics.ts mirrors these tables for typed queries and is left out of drizzle-kit's
-- schema, so a later `db:generate` doesn't try to create them again.
--
-- Raw events: append-only, one partition per UTC day (the API makes the next days' partitions and
-- drops the ones past the retention window: src/analytics/partitions.ts). No foreign keys and one
-- index, so an insert stays cheap.
CREATE TABLE "analytics_events" (
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"v" smallint NOT NULL,
	"uid" text,
	"sid" text,
	"country" text,
	"props" jsonb NOT NULL
) PARTITION BY RANGE ("at");
--> statement-breakpoint
CREATE INDEX "analytics_events_kind_at_idx" ON "analytics_events" USING btree ("kind","at");
--> statement-breakpoint
-- Rollups: anonymous counts (no player id), kept long after the raw events are gone.
CREATE TABLE "analytics_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"dim" text NOT NULL,
	"n" bigint NOT NULL,
	"sum" double precision NOT NULL,
	CONSTRAINT "analytics_hourly_pk" PRIMARY KEY("hour","metric","dim")
);
--> statement-breakpoint
CREATE TABLE "analytics_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"dim" text NOT NULL,
	"n" bigint NOT NULL,
	"sum" double precision NOT NULL,
	CONSTRAINT "analytics_daily_pk" PRIMARY KEY("day","metric","dim")
);
--> statement-breakpoint
-- One row per player per day they played (pseudonymous id): active players, retention, the segments.
CREATE TABLE "analytics_player_days" (
	"day" date NOT NULL,
	"uid" text NOT NULL,
	"consented" boolean NOT NULL,
	"sessions" integer NOT NULL,
	"active_s" integer NOT NULL,
	"matches" integer NOT NULL,
	"finished" integer NOT NULL,
	"left_early" integer NOT NULL,
	"rage" integer NOT NULL,
	"input" text,
	"form" text,
	"tier" text,
	"hours" integer NOT NULL,
	"modes" jsonb NOT NULL,
	"country" text,
	CONSTRAINT "analytics_player_days_pk" PRIMARY KEY("day","uid")
);
--> statement-breakpoint
CREATE INDEX "analytics_player_days_uid_idx" ON "analytics_player_days" USING btree ("uid");
--> statement-breakpoint
CREATE TABLE "analytics_players" (
	"uid" text PRIMARY KEY NOT NULL,
	"first_day" date NOT NULL,
	"last_day" date NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_players_first_day_idx" ON "analytics_players" USING btree ("first_day");
--> statement-breakpoint
-- Players whose stats must go (Delete my data, or the account deleted): the API's maintenance
-- deletes their raw events, day rows and segments, then the row.
CREATE TABLE "analytics_forget" (
	"uid" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION "analytics_forget_user"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "analytics_forget" ("uid", "at") VALUES (OLD."id", now()) ON CONFLICT DO NOTHING;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- an account deleted (DELETE /me, the idle-guest clean-up) or marked deleted takes its stats with it
CREATE TRIGGER "users_analytics_forget_delete" AFTER DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "analytics_forget_user"();
--> statement-breakpoint
CREATE TRIGGER "users_analytics_forget_status" AFTER UPDATE OF "status" ON "users" FOR EACH ROW WHEN (NEW."status" = 'deleted') EXECUTE FUNCTION "analytics_forget_user"();
