ALTER TABLE "exit_case" ADD COLUMN "settlement_amount_encrypted" text;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "settlement_currency" text;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "settled_on" date;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "settlement_note" text;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "settlement_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exit_case" ADD COLUMN "settlement_recorded_by" uuid;