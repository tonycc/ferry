WITH ranked AS (
	SELECT "id", ROW_NUMBER() OVER (PARTITION BY "app_name" ORDER BY "created_at" DESC, "seq" DESC) AS rn
	FROM "releases"
	WHERE "releases"."state" NOT IN ('LIVE', 'FAILED_FIXABLE', 'ROLLED_BACK', 'FAILED')
)
UPDATE "releases"
SET "state" = 'FAILED',
	"error" = COALESCE("error", '{"stage":"PENDING","type":"internal_error","message":"升级迁移时收敛重复的历史未完成发布单"}'::jsonb)
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "releases_one_active_per_app_idx" ON "releases" USING btree ("app_name") WHERE "releases"."state" NOT IN ('LIVE', 'FAILED_FIXABLE', 'ROLLED_BACK', 'FAILED');
