CREATE TABLE "payroll_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"row_count" integer NOT NULL,
	"lines" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_export_month_idx" ON "payroll_export" USING btree ("tenant_id","month","created_at");