CREATE TABLE "org_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean NOT NULL,
	"department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
