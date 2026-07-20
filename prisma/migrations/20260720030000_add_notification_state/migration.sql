-- CreateTable
CREATE TABLE "NotificationState" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationState_key_key" ON "NotificationState"("key");
