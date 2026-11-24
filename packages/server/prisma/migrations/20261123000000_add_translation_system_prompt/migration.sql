-- Existing rows retain their single-template configuration for the settings reader.
ALTER TABLE "TranslationSettings" ADD COLUMN "systemPrompt" TEXT;
