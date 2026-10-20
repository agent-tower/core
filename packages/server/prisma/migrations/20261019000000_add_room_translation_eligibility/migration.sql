-- Existing publication facts remain ineligible; do not backfill history.
ALTER TABLE "RoomMessage" ADD COLUMN "translationEligibilityEpoch" INTEGER;
CREATE INDEX "RoomMessage_translationEligibilityEpoch_id_idx" ON "RoomMessage"("translationEligibilityEpoch", "id");
