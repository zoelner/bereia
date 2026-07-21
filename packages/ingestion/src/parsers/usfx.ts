import { z } from "zod";
import { usfmBookSchema } from "@bereia/core";
import { NotImplementedError } from "../errors.js";

/**
 * Parser USFX (ebible.org) → versos brutos NA VERSIFICAÇÃO DA FONTE.
 * A normalização para a versificação-mestre KJV acontece depois, via TVTMS
 * (ADR-002) — este parser NÃO grava JSONL canônico.
 */

export const rawVerseSchema = z.object({
  /** Código de livro já mapeado para USFM (tabela de mapeamento por fonte). */
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  verse: z.number().int().positive(),
  text: z.string().min(1),
  translation: z.string().min(1),
  /** Tradição de versificação declarada da fonte, insumo do TVTMS. */
  versificationTradition: z.string().min(1),
});
export type RawVerse = z.infer<typeof rawVerseSchema>;

export function parseUsfx(_xml: string, _translation: string): RawVerse[] {
  throw new NotImplementedError("parser USFX");
}
