CREATE TABLE "checklist_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"anchor_date" date NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "checklist_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"owner_label" text NOT NULL,
	"owner_kind" text NOT NULL,
	"assignee_user_id" uuid,
	"assignee_role" "role",
	"due_on" date NOT NULL,
	"mandatory" boolean NOT NULL,
	"requires_document" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"done_by" uuid,
	"done_at" timestamp with time zone,
	"evidence_document_id" uuid,
	"note" text,
	"waive_reason" text,
	"last_reminded_on" date
);
--> statement-breakpoint
CREATE TABLE "checklist_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"stage" text NOT NULL,
	"applies_to" jsonb NOT NULL,
	"tasks" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_run" ADD CONSTRAINT "checklist_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run" ADD CONSTRAINT "checklist_run_template_id_checklist_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run" ADD CONSTRAINT "checklist_run_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run" ADD CONSTRAINT "checklist_run_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_run_id_checklist_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."checklist_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_assignee_user_id_app_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_done_by_app_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_evidence_document_id_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template" ADD CONSTRAINT "checklist_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_run_person_idx" ON "checklist_run" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "checklist_task_run_idx" ON "checklist_task" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "checklist_task_assignee_idx" ON "checklist_task" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_template_version_key" ON "checklist_template" USING btree ("tenant_id","key","version");