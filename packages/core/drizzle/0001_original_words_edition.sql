-- Migration: carimbo de edição por palavra em original_words (N0, OQ-6 do plano de fechamento).
-- Preserva o TextType/WordType cru do TAGNT (TR/NA/variante) que se perde ao gravar só strongId/strongRaw.
-- Nullable: TAHOT e demais fontes sem carimbo de edição continuam gravando null.

ALTER TABLE original_words ADD COLUMN edition text;
