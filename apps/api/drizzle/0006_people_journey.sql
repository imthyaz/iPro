CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"designation_id" uuid NOT NULL,
	"grade_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"cost_centre_id" uuid,
	"manager_engagement_id" uuid,
	"dotted_manager_engagement_id" uuid,
	"bucket" text NOT NULL,
	"work_policy_id" uuid,
	"position_id" uuid,
	"change_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compensation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"amount_encrypted" text NOT NULL,
	"rate_unit" text NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emergency_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"person_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relation" text NOT NULL,
	"phone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_code_counter" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"employee_code" text NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"work_email" text,
	"offer_date" date,
	"joining_date" date NOT NULL,
	"probation_end_date" date,
	"confirmation_date" date,
	"notice_period_days" integer,
	"resignation_date" date,
	"last_working_date" date,
	"exit_reason" text,
	"rehire_eligible" boolean,
	"previous_engagement_id" uuid
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"legal_name" text NOT NULL,
	"preferred_name" text,
	"date_of_birth" date,
	"gender" text,
	"nationality" text,
	"personal_email" text,
	"phone" text,
	"photo_document_id" uuid,
	"prior_experience_months" integer
);
--> statement-breakpoint
CREATE TABLE "tenant_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"category" text NOT NULL,
	"occurred_on" date NOT NULL,
	"is_planned" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"detail_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity" text NOT NULL,
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"migrated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_designation_id_designation_id_fk" FOREIGN KEY ("designation_id") REFERENCES "public"."designation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_grade_id_grade_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_cost_centre_id_cost_centre_id_fk" FOREIGN KEY ("cost_centre_id") REFERENCES "public"."cost_centre"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_manager_engagement_id_engagement_id_fk" FOREIGN KEY ("manager_engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_dotted_manager_engagement_id_engagement_id_fk" FOREIGN KEY ("dotted_manager_engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_code_counter" ADD CONSTRAINT "employee_code_counter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_legal_entity_id_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_setting" ADD CONSTRAINT "tenant_setting_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_event" ADD CONSTRAINT "journal_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_engagement_idx" ON "assignment" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "assignment_manager_idx" ON "assignment" USING btree ("manager_engagement_id");--> statement-breakpoint
CREATE INDEX "compensation_engagement_idx" ON "compensation" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "emergency_contact_person_idx" ON "emergency_contact" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "engagement_person_idx" ON "engagement" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "engagement_employee_code_idx" ON "engagement" USING btree ("tenant_id","employee_code");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_work_email_live_key" ON "engagement" USING btree ("tenant_id",lower("work_email")) WHERE "engagement"."status" in ('offered', 'pre_joining', 'active', 'on_notice');--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_setting_key" ON "tenant_setting" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "journal_event_person_idx" ON "journal_event" USING btree ("person_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_event_source_key" ON "journal_event" USING btree ("tenant_id","source_table","source_id","event_type");