CREATE TABLE "scheduled_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid NOT NULL,
	"request_id" uuid,
	"payload" jsonb NOT NULL,
	"run_on" date NOT NULL,
	"status" text NOT NULL,
	"applied_at" timestamp with time zone,
	"failure" text
);
--> statement-breakpoint
ALTER TABLE "scheduled_change" ADD CONSTRAINT "scheduled_change_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_change" ADD CONSTRAINT "scheduled_change_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_change" ADD CONSTRAINT "scheduled_change_request_id_workflow_instance_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_change_due_idx" ON "scheduled_change" USING btree ("tenant_id","status","run_on");