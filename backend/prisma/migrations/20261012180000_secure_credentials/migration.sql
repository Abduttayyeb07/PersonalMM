ALTER TABLE "exchange_credentials" ADD COLUMN "key_hint" TEXT;

ALTER TABLE "orders" ADD COLUMN "client_order_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "notional_usdt" DECIMAL(20,8);
UPDATE "orders" SET "client_order_id" = "id", "notional_usdt" = 0 WHERE "client_order_id" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "client_order_id" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "notional_usdt" SET NOT NULL;
CREATE UNIQUE INDEX "orders_user_id_exchange_client_order_id_key" ON "orders"("user_id", "exchange", "client_order_id");

CREATE TABLE "credential_audits" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "exchange" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credential_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credential_audits_user_id_created_at_idx"
  ON "credential_audits"("user_id", "created_at" DESC);

ALTER TABLE "credential_audits"
  ADD CONSTRAINT "credential_audits_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
