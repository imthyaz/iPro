CREATE TABLE "hybrid_compliance_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"date" date NOT NULL,
	"week_start" date NOT NULL,
	"policy_id" uuid NOT NULL,
	"required_mode" text NOT NULL,
	"required_days" smallint NOT NULL,
	"working" boolean NOT NULL,
	"on_leave" boolean NOT NULL,
	"planned_mode" text,
	"actual_status" text,
	"actual_mode" text
);
--> statement-breakpoint
ALTER TABLE "hybrid_compliance_day" ADD CONSTRAINT "hybrid_compliance_day_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_compliance_day" ADD CONSTRAINT "hybrid_compliance_day_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_compliance_day" ADD CONSTRAINT "hybrid_compliance_day_policy_id_work_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."work_policy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hybrid_compliance_day_key" ON "hybrid_compliance_day" USING btree ("tenant_id","engagement_id","date");--> statement-breakpoint
CREATE INDEX "hybrid_compliance_day_week_idx" ON "hybrid_compliance_day" USING btree ("week_start");