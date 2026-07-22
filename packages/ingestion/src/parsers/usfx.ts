import { z } from "zod";
import { usfmBookSchema } from "@bereia/core";
import type { UsfxBible, UsfxVerse } from "./usfx/parser.js";

/**
 * Parser USFX (ebible.org) → versos brutos NA VERSIFICAÇÃO DA FONTE.
 * A normalização para a versificação-mestre KJV acontece depois, via TVTMS
 * (ADR-002) — este parser NÃO grava JSONL canônico.
 */

export const rawVerseSchema = z.object({
  /** Código de livro já em USFM (os USFX do ebible.org usam os códigos padrão). */
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  verse: z.number().int().positive(),
  /** Igual a `verse`, salvo versos em ponte ("15-16" na WEB) — decisão de split na ingestão. */
  verseEnd: z.number().int().positive(),
  text: z.string().min(1),
  translation: z.string().min(1),
  /** Tradição de versificação declarada da fonte, insumo do TVTMS. */
  versificationTradition: z.string().min(1),
});
export type RawVerse = z.infer<typeof rawVerseSchema>;

/** Achata a estrutura parseada em versos brutos (títulos de Salmos ficam de fora — ver UsfxChapter.title). */
export function flattenUsfx(
  bible: UsfxBible,
  translation: string,
  versificationTradition: string,
): RawVerse[] {
  const out: RawVerse[] = [];
  for (const [, chapters] of bible.books) {
    for (const [, chapter] of chapters) {
      const seen = new Set<UsfxVerse>();
      for (const [, verse] of chapter.verses) {
        if (seen.has(verse) || verse.text === "") continue;
        seen.add(verse);
        out.push(
          rawVerseSchema.parse({
            book: verse.book,
            chapter: verse.chapter,
            verse: verse.verse,
            verseEnd: verse.verseEnd,
            text: verse.text,
            translation,
            versificationTradition,
          }),
        );
      }
    }
  }
  return out;
}

export * from "./usfx/parser.js";
export * from "./usfx/inventory.js";
