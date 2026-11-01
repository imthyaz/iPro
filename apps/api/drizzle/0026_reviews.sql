CREATE TABLE "review" (
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
	"due_on" date NOT NULL,
	"reviewer_user_id" uuid,
	"recommendation" text,
	"ratings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strengths" text,
	"improvements" text,
	"comments" text,
	"new_end_date" date,
	"last_working_date" date,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"request_id" uuid,
	"decision" text,
	"decided_at" timestamp with time zone,
	"reminded_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_escalated_on" date,
	"escalation_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_user_id_app_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_request_id_workflow_instance_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_engagement_idx" ON "review" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "review_status_idx" ON "review" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "review_open_key" ON "review" USING btree ("tenant_id","engagement_id","kind") WHERE "review"."status" in ('due', 'submitted');