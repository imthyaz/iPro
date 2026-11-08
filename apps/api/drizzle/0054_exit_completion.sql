ALTER TABLE "exit_case" ADD COLUMN "clearance_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "interview_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "interview_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "interview_declined" boolean;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "interview_answers" jsonb;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "interview_note" text;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "rehire_eligible" boolean;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "access_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "access_method" text;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "exited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "exited_by" uuid;