CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"service_url" text NOT NULL,
	"conversation_id" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_conversation" ADD CONSTRAINT "teams_conversation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_conversation" ADD CONSTRAINT "teams_conversation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_due_idx" ON "notification_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_once_key" ON "notification_delivery" USING btree ("tenant_id","notification_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_conversation_user_key" ON "teams_conversation" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_key" ON "notification" USING btree ("tenant_id","recipient_user_id","dedupe_key") WHERE "notification"."dedupe_key" is not null;