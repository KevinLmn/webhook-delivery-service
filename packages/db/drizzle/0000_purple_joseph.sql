CREATE TABLE IF NOT EXISTS "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"error_class" text,
	"response_body_excerpt" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" "bytea" NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_status_check" CHECK ("events"."status" IN ('pending','delivered','dead'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_attempts_event_attempt_uniq" ON "delivery_attempts" USING btree ("event_id","attempt_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoints_client_active_idx" ON "endpoints" USING btree ("client_id") WHERE "endpoints"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_endpoint_status_idx" ON "events" USING btree ("endpoint_id","status","created_at");