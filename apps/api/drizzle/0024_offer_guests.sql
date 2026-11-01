ALTER TABLE "offer" ADD COLUMN "guest_status" text;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "guest_object_id" text;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "guest_user_id" uuid;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "guest_invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_guest_user_id_app_user_id_fk" FOREIGN KEY ("guest_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE offer ADD CONSTRAINT offer_guest_status_check
  CHECK (guest_status IS NULL OR guest_status IN ('invited', 'failed', 'retired'));
--> statement-breakpoint
CREATE INDEX offer_guest_object_idx ON offer (guest_object_id) WHERE guest_object_id IS NOT NULL;
