ALTER TABLE "apps" ADD COLUMN "visibility_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- 已经上线过的应用:可见范围从此以控制台为准
UPDATE "apps" SET "visibility_pinned" = true WHERE "live_version" IS NOT NULL;
