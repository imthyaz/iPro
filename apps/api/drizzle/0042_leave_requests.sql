CREATE TABLE "leave_request_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"day" date NOT NULL,
	"half" text NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"amount" smallint NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leave_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"start_half" text NOT NULL,
	"end_half" text NOT NULL,
	"days" integer NOT NULL,
	"lop_days" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"unplanned" boolean DEFAULT false NOT NULL,
	"needs_certificate" boolean DEFAULT false NOT NULL,
	"certificate_document_id" uuid,
	"workflow_instance_id" uuid,
	"decided_at" timestamp with time zone,
	"revoked_from" date,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "counts_calendar_days" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_request_id_leave_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."leave_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_request_day_engagement_idx" ON "leave_request_day" USING btree ("engagement_id","day");--> statement-breakpoint
CREATE INDEX "leave_request_day_request_idx" ON "leave_request_day" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "leave_request_person_idx" ON "leave_request" USING btree ("person_id","from_date");