CREATE TABLE "hybrid_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"policy_id" uuid NOT NULL,
	"reasons" jsonb NOT NULL,
	"note" text,
	"status" text NOT NULL,
	"workflow_instance_id" uuid
);
--> statement-breakpoint
CREATE TABLE "seat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"zone" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_anchor_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"manager_engagement_id" uuid NOT NULL,
	"weekday" smallint
);
--> statement-breakpoint
CREATE TABLE "work_booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"date" date NOT NULL,
	"week_start" date NOT NULL,
	"mode" text NOT NULL,
	"location_id" uuid,
	"seat_id" uuid,
	"status" text NOT NULL,
	"exception_id" uuid
);
--> statement-breakpoint
CREATE TABLE "work_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"required_mode" text NOT NULL,
	"required_days" smallint NOT NULL,
	"anchor_day_required" boolean DEFAULT false NOT NULL,
	"allowed_modes" text[] NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"location_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"priority" smallint NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hybrid_exception" ADD CONSTRAINT "hybrid_exception_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_exception" ADD CONSTRAINT "hybrid_exception_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_exception" ADD CONSTRAINT "hybrid_exception_policy_id_work_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."work_policy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_anchor_day" ADD CONSTRAINT "team_anchor_day_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_anchor_day" ADD CONSTRAINT "team_anchor_day_manager_engagement_id_engagement_id_fk" FOREIGN KEY ("manager_engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_booking" ADD CONSTRAINT "work_booking_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_booking" ADD CONSTRAINT "work_booking_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_booking" ADD CONSTRAINT "work_booking_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_booking" ADD CONSTRAINT "work_booking_seat_id_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seat"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_booking" ADD CONSTRAINT "work_booking_exception_id_hybrid_exception_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."hybrid_exception"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_policy" ADD CONSTRAINT "work_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hybrid_exception_week_idx" ON "hybrid_exception" USING btree ("engagement_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_label_key" ON "seat" USING btree ("tenant_id","location_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "team_anchor_day_manager_key" ON "team_anchor_day" USING btree ("tenant_id","manager_engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_booking_day_key" ON "work_booking" USING btree ("tenant_id","engagement_id","date") WHERE "work_booking"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "work_booking_seat_key" ON "work_booking" USING btree ("tenant_id","seat_id","date") WHERE "work_booking"."seat_id" is not null and "work_booking"."status" in ('confirmed', 'pending');--> statement-breakpoint
CREATE INDEX "work_booking_location_idx" ON "work_booking" USING btree ("location_id","date");--> statement-breakpoint
CREATE INDEX "work_booking_week_idx" ON "work_booking" USING btree ("engagement_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "work_policy_code_key" ON "work_policy" USING btree ("tenant_id","code");