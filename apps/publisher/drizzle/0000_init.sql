CREATE TABLE "apps" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"visibility" text DEFAULT 'self' NOT NULL,
	"host" text NOT NULL,
	"platform" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"live_version" text,
	"disabled" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_host_unique" UNIQUE("host")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "releases_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"app_name" text NOT NULL,
	"owner_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"state" text NOT NULL,
	"backup_id" text,
	"error" jsonb,
	"url" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"app_name" text NOT NULL,
	"owner_id" text NOT NULL,
	"version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_app_name_apps_name_fk" FOREIGN KEY ("app_name") REFERENCES "public"."apps"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_app_name_apps_name_fk" FOREIGN KEY ("app_name") REFERENCES "public"."apps"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_owner_id_idx" ON "apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "releases_app_name_idx" ON "releases" USING btree ("app_name","created_at","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_app_version_idx" ON "uploads" USING btree ("app_name","version");