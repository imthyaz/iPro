CREATE TABLE "offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"status" text NOT NULL,
	"band_check" text NOT NULL,
	"letter_template_key" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"letter_id" uuid,
	"approval_request_id" uuid,
	"offered_at" timestamp with time zone,
	"expires_on" date,
	"accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text
);
--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "contract_end_date" date;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_letter_id_letter_id_fk" FOREIGN KEY ("letter_id") REFERENCES "public"."letter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_approval_request_id_workflow_instance_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."workflow_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_engagement_key" ON "offer" USING btree ("tenant_id","engagement_id");--> statement-breakpoint
CREATE INDEX "offer_status_idx" ON "offer" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "offer_letter_idx" ON "offer" USING btree ("letter_id");