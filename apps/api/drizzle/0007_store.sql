CREATE TABLE "inventory" (
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pool" text NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"ref" text NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ledger_pool_check" CHECK ("ledger"."pool" in ('paid', 'earned')),
	CONSTRAINT "ledger_kind_check" CHECK ("ledger"."kind" in ('purchase', 'grant', 'spend', 'refund', 'reversal', 'adjust')),
	CONSTRAINT "ledger_delta_check" CHECK ("ledger"."delta" <> 0),
	CONSTRAINT "ledger_balance_after_check" CHECK ("ledger"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"provider" text NOT NULL,
	"bundle_id" text NOT NULL,
	"brass" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"cap_cents" integer NOT NULL,
	"status" text NOT NULL,
	"provider_tx_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_attempts" smallint DEFAULT 0 NOT NULL,
	"refund_ref" text,
	CONSTRAINT "payments_provider_tx_id_unique" UNIQUE("provider_tx_id"),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('created', 'paid', 'failed', 'refund_pending', 'refunded')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_minor" > 0 and "payments"."brass" > 0)
);
--> statement-breakpoint
CREATE TABLE "store_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"reason" text NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"earned" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"monthly_cap_cents" integer DEFAULT 10000 NOT NULL,
	"cap_raise_cents" integer,
	"cap_raise_at" timestamp with time zone,
	"flagged_at" timestamp with time zone,
	"flag_reason" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallets_paid_check" CHECK ("wallets"."paid" >= 0),
	CONSTRAINT "wallets_earned_check" CHECK ("wallets"."earned" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_kind_pool_ref_idx" ON "ledger" USING btree ("kind","pool","ref");--> statement-breakpoint
CREATE INDEX "ledger_user_id_idx" ON "ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "store_audit_user_id_idx" ON "store_audit" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "wallets_flagged_at_idx" ON "wallets" USING btree ("flagged_at");--> statement-breakpoint
-- The ledger and the owner's store audit are append-only (docs/17 §2.5): no UPDATE, and no DELETE except a
-- ledger row going with its account (the users foreign key's cascade runs as a nested trigger, depth >= 2).
CREATE FUNCTION "append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'ledger' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ledger_append_only" BEFORE UPDATE OR DELETE ON "ledger" FOR EACH ROW EXECUTE FUNCTION "append_only"();--> statement-breakpoint
CREATE TRIGGER "store_audit_append_only" BEFORE UPDATE OR DELETE ON "store_audit" FOR EACH ROW EXECUTE FUNCTION "append_only"();
