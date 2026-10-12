-- CreateTable
CREATE TABLE "execution_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "side" TEXT,
    "type" TEXT,
    "quantity" TEXT,
    "price" TEXT,
    "quote_qty" TEXT,
    "client_order_id" TEXT,
    "exchange_order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_logs_user_id_exchange_idx" ON "execution_logs"("user_id", "exchange");

-- CreateIndex
CREATE INDEX "execution_logs_user_id_created_at_idx" ON "execution_logs"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
