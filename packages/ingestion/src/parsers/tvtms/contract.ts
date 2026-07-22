import { z } from "zod";
import { usfmBookSchema } from "@bereia/core";

/**
 * Contrato público da normalização de versificação (ADR-002).
 * COMPONENTE CRÍTICO: erro aqui contamina canonical_id sistematicamente.
 */

export const sourceRefSchema = z.object({
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  verse: z.number().int().positive(),
  /** Tradição de versificação da fonte (ex.: "Hebrew", "Eng-KJV") — desempate quando os Tests não bastam. */
  tradition: z.string().min(1),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** Resultado do mapeamento: um verso-fonte pode mapear para 0..n versos KJV (splits/merges). */
export const mappedRefSchema = z.object({
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  /** 0 = título de Salmo (Standard "Title" do TVTMS); como o título entra no canonical_id é decisão da ingestão. */
  verse: z.number().int().nonnegative(),
  /** Parte do verso quando há split (ex.: "a"/"b"); null quando 1:1. */
  subverse: z.string().nullable(),
});
export type MappedRef = z.infer<typeof mappedRefSchema>;

export interface VersificationMapper {
  /** Mapeia uma referência da tradição da fonte para a versificação-mestre KJV. */
  toKjv(ref: SourceRef): MappedRef[];
}
