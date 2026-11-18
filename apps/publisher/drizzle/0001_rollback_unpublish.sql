ALTER TABLE "apps" ADD COLUMN "unpublished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "kind" text DEFAULT 'publish' NOT NULL;