import { z } from "zod";
import { usfmBookSchema } from "@bereia/core";
import { NotImplementedError } from "../errors.js";

/**
 * Normalização de versificação via STEPBible TVTMS (ADR-002).
 *
 * COMPONENTE CRÍTICO: erro aqui contamina canonical_id sistematicamente.
 * Gate da Fase 1: a suíte de casos-ouro (títulos de Salmos, Ml 3/4, Jl 2/3,
 * 3Jo, Rm 16:25-27, versos ausentes em textos críticos) precisa passar 100%
 * antes do primeiro data/canonical/*.jsonl.
 */

export const sourceRefSchema = z.object({
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  verse: z.number().int().positive(),
  /** Tradição de versificação da fonte (ex.: hebraica, grega, latina). */
  tradition: z.string().min(1),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** Resultado do mapeamento: um verso-fonte pode mapear para 0..n versos KJV (splits/merges). */
export const mappedRefSchema = z.object({
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  verse: z.number().int().positive(),
  /** Parte do verso quando há split (ex.: "a"/"b"); null quando 1:1. */
  subverse: z.string().nullable(),
});
export type MappedRef = z.infer<typeof mappedRefSchema>;

export interface VersificationMapper {
  /** Mapeia uma referência da tradição da fonte para a versificação-mestre KJV. */
  toKjv(ref: SourceRef): MappedRef[];
}

export function loadTvtms(_tsv: string): VersificationMapper {
  throw new NotImplementedError("carregador TVTMS");
}
