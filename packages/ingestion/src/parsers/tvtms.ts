import { parseTvtmsExpanded } from "./tvtms/expanded.js";
import { TvtmsMapper, type StandardInventory } from "./tvtms/mapper.js";
import type { SourceInventory } from "./tvtms/tests-grammar.js";
import type { VersificationMapper } from "./tvtms/contract.js";

/**
 * Normalização de versificação via STEPBible TVTMS (ADR-002).
 *
 * Gate da Fase 1: a suíte de casos-ouro (títulos de Salmos, Ml 3/4, Jl 2/3,
 * 3Jo, Rm 16:25-27, versos ausentes em textos críticos) precisa passar 100%
 * antes do primeiro data/canonical/*.jsonl.
 *
 * O mapeador NÃO é uma tabela estática: os Tests do TVTMS são condições sobre
 * o conteúdo da Bíblia-fonte, por isso `loadTvtms` exige a fonte já parseada
 * (SourceInventory) e a contagem de versos da versificação-mestre
 * (StandardInventory, para expandir ranges).
 */
export function loadTvtms(
  tsv: string,
  sourceInventory: SourceInventory,
  standardInventory: StandardInventory,
): VersificationMapper {
  const { rules } = parseTvtmsExpanded(tsv);
  return new TvtmsMapper(rules, sourceInventory, standardInventory);
}

export * from "./tvtms/contract.js";
export * from "./tvtms/books.js";
export * from "./tvtms/refs.js";
export * from "./tvtms/tests-grammar.js";
export * from "./tvtms/expanded.js";
export * from "./tvtms/mapper.js";
