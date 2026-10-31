CREATE TABLE "business_unit_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"business_unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"head_person_id" uuid
);
--> statement-breakpoint
CREATE TABLE "business_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_centre" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"owner_person_id" uuid
);
--> statement-breakpoint
CREATE TABLE "department_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"parent_department_id" uuid,
	"head_person_id" uuid
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"title" text NOT NULL,
	"grade_id" uuid NOT NULL,
	"designation_band" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"band_min" bigint,
	"band_max" bigint,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"level_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"name" text NOT NULL,
	"country" char(2) DEFAULT 'IN' NOT NULL,
	"pan" text,
	"tan" text,
	"gstin" text,
	"registered_address" text,
	"default_currency" char(3) DEFAULT 'INR' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"address" text,
	"state" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"holiday_calendar_id" uuid,
	"seat_count" integer
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL,
	"legal_entity_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"code" text NOT NULL,
	"designation_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"cost_centre_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"budgeted_ctc" bigint,
	"currency" char(3) DEFAULT 'INR' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_unit_version" ADD CONSTRAINT "business_unit_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_unit_version" ADD CONSTRAINT "business_unit_version_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_version" ADD CONSTRAINT "department_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_version" ADD CONSTRAINT "department_version_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_version" ADD CONSTRAINT "department_version_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_version" ADD CONSTRAINT "department_version_parent_department_id_department_id_fk" FOREIGN KEY ("parent_department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designation" ADD CONSTRAINT "designation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designation" ADD CONSTRAINT "designation_grade_id_grade_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade" ADD CONSTRAINT "grade_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entity" ADD CONSTRAINT "legal_entity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_version" ADD CONSTRAINT "location_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_version" ADD CONSTRAINT "location_version_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_legal_entity_id_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_designation_id_designation_id_fk" FOREIGN KEY ("designation_id") REFERENCES "public"."designation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_cost_centre_id_cost_centre_id_fk" FOREIGN KEY ("cost_centre_id") REFERENCES "public"."cost_centre"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_unit_version_unit_idx" ON "business_unit_version" USING btree ("business_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_unit_code_key" ON "business_unit" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_centre_code_key" ON "cost_centre" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "department_version_unit_idx" ON "department_version" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "department_code_key" ON "department" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "grade_code_key" ON "grade" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "location_version_unit_idx" ON "location_version" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_code_key" ON "location" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "position_code_key" ON "position" USING btree ("tenant_id","code");