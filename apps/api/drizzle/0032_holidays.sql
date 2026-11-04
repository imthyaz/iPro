CREATE TABLE "holiday_calendar" (
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
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"calendar_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"optional" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_assignment" ADD COLUMN "holiday_calendar_id" uuid;--> statement-breakpoint
ALTER TABLE "holiday_calendar" ADD CONSTRAINT "holiday_calendar_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_calendar_id_holiday_calendar_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."holiday_calendar"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_calendar_code_key" ON "holiday_calendar" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_calendar_date_key" ON "holiday" USING btree ("tenant_id","calendar_id","date") WHERE "holiday"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "shift_assignment" ADD CONSTRAINT "shift_assignment_holiday_calendar_id_holiday_calendar_id_fk" FOREIGN KEY ("holiday_calendar_id") REFERENCES "public"."holiday_calendar"("id") ON DELETE no action ON UPDATE no action;