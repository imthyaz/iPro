CREATE TABLE "probation_check_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"due_on" date NOT NULL,
	"reviewer_user_id" uuid,
	"progress" text,
	"notes" text,
	"recorded_at" timestamp with time zone,
	"recorded_by" uuid,
	"reminded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "convert_to" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "convert_probation" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "return_by" date;--> statement-breakpoint
ALTER TABLE "probation_check_in" ADD CONSTRAINT "probation_check_in_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_check_in" ADD CONSTRAINT "probation_check_in_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_check_in" ADD CONSTRAINT "probation_check_in_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_check_in" ADD CONSTRAINT "probation_check_in_reviewer_user_id_app_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_check_in" ADD CONSTRAINT "probation_check_in_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probation_check_in_month_key" ON "probation_check_in" USING btree ("tenant_id","engagement_id","month");