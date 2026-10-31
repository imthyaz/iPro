CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"name" text NOT NULL,
	"plan" text DEFAULT 'standard' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
