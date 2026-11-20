CREATE TABLE "app_secrets" (
	"app_name" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "app_secrets_app_name_name_pk" PRIMARY KEY("app_name","name")
);
--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_app_name_apps_name_fk" FOREIGN KEY ("app_name") REFERENCES "public"."apps"("name") ON DELETE no action ON UPDATE no action;