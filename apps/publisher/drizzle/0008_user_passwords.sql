CREATE TABLE "user_passwords" (
	"user_id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"must_change" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text
);
