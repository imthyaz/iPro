CREATE TABLE "comp_off_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"day_kind" text NOT NULL,
	"amount" smallint NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"workflow_instance_id" uuid,
	"granted_on" date,
	"valid_until" date,
	"expired_at" timestamp with time zone,
	"expired_amount" smallint
);
--> statement-breakpoint
ALTER TABLE "comp_off_request" ADD CONSTRAINT "comp_off_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_request" ADD CONSTRAINT "comp_off_request_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_request" ADD CONSTRAINT "comp_off_request_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comp_off_request_day_key" ON "comp_off_request" USING btree ("tenant_id","engagement_id","worked_on") WHERE "comp_off_request"."status" in ('applied', 'returned', 'approved');--> statement-breakpoint
CREATE INDEX "comp_off_request_expiry_idx" ON "comp_off_request" USING btree ("valid_until") WHERE "comp_off_request"."status" = 'approved' and "comp_off_request"."expired_at" is null;