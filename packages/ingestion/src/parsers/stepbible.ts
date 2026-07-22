/**
 * Parsers dos TSV do STEPBible (CC BY 4.0), ver docs/plano-stepbible.md:
 * - TAHOT: AT hebraico tageado (Strong + morfologia), 4 arquivos amalgamados.
 * - TAGNT: NT grego (TR e NA27/28 marcados por edição, por palavra), 2 arquivos.
 * A referência da coluna 1 já traz o KJV embutido (produtor do canonical_id,
 * ADR-002 §3.1); o gate de versificação (N5) faz a checagem cruzada com o
 * mapper TVTMS sobre o TAHOT real. Implementação em `stepbible/` (N1-N5);
 * este módulo é só a fachada do pacote.
 */
export * from "./stepbible/index.js";
