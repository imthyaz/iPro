CREATE TABLE "exit_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"resignation_date" date NOT NULL,
	"reason" text,
	"reason_note" text,
	"notice_days" smallint NOT NULL,
	"notice_last_day" date NOT NULL,
	"proposed_last_day" date,
	"last_working_date" date,
	"early_release" text,
	"buyout_days" smallint,
	"retention_note" text,
	"manager_accepted_by" uuid,
	"manager_accepted_at" timestamp with time zone,
	"hr_accepted_by" uuid,
	"hr_accepted_at" timestamp with time zone,
	"hr_note" text,
	"accepted_at" timestamp with time zone,
	"workflow_instance_id" uuid,
	"withdrawal_instance_id" uuid,
	"withdraw_reason" text,
	"withdrawn_at" timestamp with time zone,
	"termination_reason" text
);
--> statement-breakpoint
ALTER TABLE "exit_case" ADD CONSTRAINT "exit_case_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_case" ADD CONSTRAINT "exit_case_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exit_case_open_key" ON "exit_case" USING btree ("tenant_id","engagement_id") WHERE "exit_case"."status" in ('submitted', 'serving_notice', 'clearance');--> statement-breakpoint
CREATE INDEX "exit_case_status_idx" ON "exit_case" USING btree ("status");