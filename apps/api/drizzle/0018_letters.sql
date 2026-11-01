CREATE TABLE "letter_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"approver_role" text,
	"signature" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_request_id" uuid,
	"esign_provider" text,
	"esign_request_id" text,
	"sent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_document_id" uuid
);
--> statement-breakpoint
ALTER TABLE "letter_template" ADD CONSTRAINT "letter_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_template_id_letter_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."letter_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_signed_document_id_document_id_fk" FOREIGN KEY ("signed_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "letter_template_version_key" ON "letter_template" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE INDEX "letter_person_idx" ON "letter" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "letter_esign_request_key" ON "letter" USING btree ("tenant_id","esign_request_id");