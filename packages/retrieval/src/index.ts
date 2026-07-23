/**
 * Barrel do pacote `@bereia/retrieval`. Exporta a composição `PgRetrieval`
 * (N6) — o adapter pronto para uso — mais os módulos de baixo nível (N2-N5)
 * e seus tipos públicos, para quem precisar compor de forma mais fina (ex.:
 * o harness de eval, N8). Ponto único de edição pós-G2 (plano §6, "Notas de
 * disjunção").
 *
 * Sem colisão de nomes: cada módulo exporta apenas a sua função/tipo
 * homônimos (`searchByTheme`, `getExegesis`, `getCrossReferences`,
 * `QueryEmbedder`/`HttpQueryEmbedder`/...); `PgRetrieval` é o único nome de
 * classe do pacote.
 */
export * from "./embedder.js";
export * from "./search-theme.js";
export * from "./exegesis.js";
export * from "./cross-references.js";
export * from "./pg-retrieval.js";
