CREATE TABLE "leave_ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"entry_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"period" text,
	"note" text,
	"source_table" text,
	"source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "leave_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"paid" boolean NOT NULL,
	"per_year" integer,
	"accrues_after_confirmation" boolean DEFAULT false NOT NULL,
	"available_on_probation" boolean DEFAULT true NOT NULL,
	"max_balance" integer,
	"carry_forward_cap" integer,
	"encashable" boolean DEFAULT false NOT NULL,
	"document_after_days" smallint,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"max_per_request" integer,
	"expires_after_days" smallint,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_ledger_entry" ADD CONSTRAINT "leave_ledger_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger_entry" ADD CONSTRAINT "leave_ledger_entry_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger_entry" ADD CONSTRAINT "leave_ledger_entry_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_ledger_balance_idx" ON "leave_ledger_entry" USING btree ("engagement_id","leave_type_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_ledger_scheduled_key" ON "leave_ledger_entry" USING btree ("tenant_id","engagement_id","leave_type_id","kind","period") WHERE "leave_ledger_entry"."kind" in ('accrual', 'carry_forward', 'lapse');--> statement-breakpoint
CREATE UNIQUE INDEX "leave_type_code_key" ON "leave_type" USING btree ("tenant_id","code");