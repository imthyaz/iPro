CREATE TABLE "attendance_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"day" date NOT NULL,
	"status" text NOT NULL,
	"first_in" timestamp with time zone,
	"last_out" timestamp with time zone,
	"worked_minutes" integer,
	"mode" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"regularised" boolean DEFAULT false NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_device" (
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
	"location_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "punch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"direction" text,
	"source" text NOT NULL,
	"mode" text,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_metres" double precision,
	"site_location_id" uuid,
	"distance_metres" integer,
	"outside_geofence" boolean,
	"device_id" uuid,
	"external_id" text
);
--> statement-breakpoint
ALTER TABLE "location_version" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "location_version" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "location_version" ADD COLUMN "geofence_radius_metres" integer;--> statement-breakpoint
ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_device" ADD CONSTRAINT "biometric_device_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch" ADD CONSTRAINT "punch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch" ADD CONSTRAINT "punch_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch" ADD CONSTRAINT "punch_device_id_biometric_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."biometric_device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_day_key" ON "attendance_day" USING btree ("tenant_id","engagement_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "biometric_device_code_key" ON "biometric_device" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "biometric_device_key_hash_key" ON "biometric_device" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "punch_engagement_day_idx" ON "punch" USING btree ("engagement_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "punch_device_external_key" ON "punch" USING btree ("tenant_id","device_id","external_id") WHERE "punch"."device_id" is not null;