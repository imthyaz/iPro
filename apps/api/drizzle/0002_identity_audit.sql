CREATE TYPE "public"."role" AS ENUM('employee', 'manager', 'hr', 'hr_head', 'cxo', 'admin');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"entra_object_id" text,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"person_id" uuid,
	"last_sign_in_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_delegation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "auth_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entra_group_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"entra_group_id" text NOT NULL,
	"role" "role" NOT NULL,
	"legal_entity_id" uuid
);
--> statement-breakpoint
CREATE TABLE "role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"legal_entity_id" uuid,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid,
	"subject_person_id" uuid,
	"field_changes" jsonb,
	"request_id" uuid,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_data_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"key_ref" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegation" ADD CONSTRAINT "approval_delegation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegation" ADD CONSTRAINT "approval_delegation_delegator_user_id_app_user_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegation" ADD CONSTRAINT "approval_delegation_delegate_user_id_app_user_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_request" ADD CONSTRAINT "auth_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entra_group_role" ADD CONSTRAINT "entra_group_role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_data_key" ADD CONSTRAINT "tenant_data_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_entra_object_id_key" ON "app_user" USING btree ("tenant_id","entra_object_id") WHERE "app_user"."entra_object_id" is not null;--> statement-breakpoint
CREATE INDEX "approval_delegation_delegator_idx" ON "approval_delegation" USING btree ("delegator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_request_state_key" ON "auth_request" USING btree ("state");--> statement-breakpoint
CREATE INDEX "entra_group_role_group_idx" ON "entra_group_role" USING btree ("entra_group_id");--> statement-breakpoint
CREATE INDEX "role_assignment_user_idx" ON "role_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "audit_log_record_idx" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("created_by","at");