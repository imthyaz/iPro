CREATE TABLE "attendance_regularisation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"reason_code" text,
	"note" text,
	"status" text NOT NULL,
	"first_in" timestamp with time zone,
	"last_out" timestamp with time zone,
	"state" text NOT NULL,
	"workflow_instance_id" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attendance_regularisation" ADD CONSTRAINT "attendance_regularisation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_regularisation" ADD CONSTRAINT "attendance_regularisation_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_regularisation_person_day_idx" ON "attendance_regularisation" USING btree ("person_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_regularisation_open_key" ON "attendance_regularisation" USING btree ("tenant_id","engagement_id","day") WHERE "attendance_regularisation"."state" in ('pending', 'returned');