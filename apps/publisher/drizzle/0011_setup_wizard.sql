CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"public_url" text,
	"apps_domain" text,
	"apps_url_scheme" text,
	"certificate" jsonb,
	"setup_code_hash" text,
	"setup_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_single_row" CHECK ("instance_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "setup_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
