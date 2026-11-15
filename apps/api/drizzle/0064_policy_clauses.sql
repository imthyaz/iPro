CREATE TABLE "policy_clause" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"number" text,
	"heading" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_version" ADD COLUMN "text_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_version" ADD COLUMN "clause_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_clause" ADD CONSTRAINT "policy_clause_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_clause" ADD CONSTRAINT "policy_clause_policy_version_id_policy_version_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_clause_position_key" ON "policy_clause" USING btree ("policy_version_id","position");