/**
 * Harness do eval de retrieval (Fase 2, N8 — plano `docs/plano-fase2-retrieval.md`
 * §5.2, o GATE da fase). Roda cada `EvalCase` (formato do N7, `./schema.ts`)
 * contra um `RetrievalService` (`@bereia/core`) já pronto e aplica o critério
 * de cobertura/`strict` decidido em OQ-6.
 *
 * ## Injeção — o harness NÃO decide infra
 * `runEval` recebe o `RetrievalService` já construído (real `PgRetrieval`
 * contra Postgres, ou um fake em memória) — abrir conexão, escolher URL do
 * embedder, subir/derrubar banco efêmero é responsabilidade de quem chama
 * (teste, script de CI, o futuro N9). Isso deixa o mesmo harness rodar
 * idêntico em unit (fake) e integração (Postgres real).
 *
 * ## Critério de aprovação (OQ-6, plano §5.2)
 * - **Cobertura (default, `strict: false`):** todo `expectedIds` do caso
 *   precisa aparecer entre os primeiros `limit` resultados de
 *   `searchByTheme` (`expectedIds ⊆ topN`), independente da posição relativa
 *   entre eles.
 * - **`strict: true` (opt-in por caso):** exatidão de PREFIXO — os
 *   `expectedIds`, NA ORDEM EXATA declarada no caso, precisam ocupar o topo
 *   do ranking (`ranking.slice(0, expectedIds.length) === expectedIds`).
 * - Em ambos os casos, `missing` no report lista os `expectedIds` ausentes de
 *   `topN` — diagnóstico útil mesmo quando o critério aplicado é `strict`
 *   (um caso `strict` pode falhar só por ordem, com `missing` vazio).
 *
 * ## Determinismo do report
 * Os casos são avaliados em SÉRIE, na ordem em que aparecem em `cases`
 * (nunca `Promise.all`/paralelo) — a ordem de `report.cases` espelha
 * exatamente a ordem de entrada, então dois `runEval` com a mesma lista de
 * casos e o mesmo `RetrievalService` determinístico produzem reports
 * estruturalmente idênticos (`eval.test.ts` prova isso rodando 2×). O
 * harness em si não introduz nenhuma fonte de não-determinismo (sem
 * `Date.now()`, sem `Math.random()`, sem ordenação instável) — qualquer
 * variação entre execuções vem do `RetrievalService` injetado, não daqui.
 *
 * ## Como o N9 vai rodar (perguntas-ouro REAIS)
 * O N9 (data-steward, curadoria do dono) grava
 * `packages/retrieval/eval/perguntas-ouro.jsonl` com queries e `expectedIds`
 * reais (nunca inventados por agente, CLAUDE.md §7). O gate real é:
 *
 * ```ts
 * import { parseEvalCasesJsonl } from "./schema.js";
 * import { runEval } from "./harness.js";
 * import { PgRetrieval, createQueryEmbedder } from "@bereia/retrieval";
 *
 * const cases = parseEvalCasesJsonl(readFileSync("perguntas-ouro.jsonl", "utf8"));
 * const service = new PgRetrieval({ sql, embedder: createQueryEmbedder(EMBEDDER_URL) });
 * const report = await runEval(service, cases);
 * // report.failed === 0 é o gate; report.cases[i].missing/ranking diagnosticam falhas.
 * ```
 *
 * Contra o Postgres carregado por `load:postgres` com os embeddings oficiais
 * do corpus (ADR-005) — MESMO harness, MESMO critério, só o arquivo de casos
 * e o backend de dados mudam. Nenhuma lógica deste módulo é específica do
 * mock.
 */

import { z } from "zod";
import {
  canonicalIdSchema,
  type CanonicalId,
  type RetrievalService,
  type ThemeSearchOptions,
  type User,
} from "@bereia/core";
import { evalCaseIdSchema, type EvalCase } from "./schema.js";

/**
 * Critério de aprovação efetivamente aplicado ao caso — espelha `EvalCase.strict`
 * (`false` → `"coverage"`, `true` → `"strict"`), fixado no report para que o
 * diagnóstico não dependa de reconsultar o arquivo de casos.
 */
export const evalCriterionSchema = z.enum(["coverage", "strict"]);
export type EvalCriterion = z.infer<typeof evalCriterionSchema>;

export const evalCaseReportSchema = z.object({
  id: evalCaseIdSchema,
  passed: z.boolean(),
  criterion: evalCriterionSchema,
  /** `expectedIds` ausentes dos primeiros `limit` resultados — vazio quando a cobertura é total. */
  missing: z.array(canonicalIdSchema),
  /** Ranking efetivo (`canonicalId` por posição), já truncado em `limit`. */
  ranking: z.array(canonicalIdSchema),
  /**
   * Métrica OBSERVACIONAL (não afeta `passed`): recall dentro do topo já
   * truncado em `limit` — `|expectedIds ∩ ranking| / |expectedIds|`, em
   * `[0, 1]`. Útil para comparar tuning quantitativamente (ex.: fusão
   * on/off) sem depender do critério binário de aprovação.
   */
  recallAtLimit: z.number().min(0).max(1),
  /**
   * Métrica OBSERVACIONAL (não afeta `passed`): posição 1-based do PRIMEIRO
   * `expectedId` encontrado no ranking COMPLETO devolvido pelo serviço para
   * o caso — deliberadamente NÃO truncado em `limit` (ao contrário de
   * `ranking`/`recallAtLimit`), para servir de métrica de progresso mesmo
   * quando o `expectedId` cai fora do topo hoje (ex.: rank 40 → rank 12 é
   * progresso visível, mesmo que ambos falhem o gate). `null` quando nenhum
   * `expectedId` aparece em nenhuma posição do ranking completo.
   */
  firstExpectedRank: z.number().int().positive().nullable(),
});
export type EvalCaseReport = z.infer<typeof evalCaseReportSchema>;

export const evalReportSchema = z.object({
  cases: z.array(evalCaseReportSchema),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Média de `recallAtLimit` entre os casos — `0` quando `cases` está vazio (evita `NaN`). Observacional. */
  meanRecallAtLimit: z.number().min(0).max(1),
  /** Quantos casos têm ao menos 1 `expectedId` em alguma posição do ranking completo (`firstExpectedRank !== null`). Observacional. */
  casesWithExpectedFound: z.number().int().nonnegative(),
});
export type EvalReport = z.infer<typeof evalReportSchema>;

/**
 * Usuário default injetado no hard filter de `searchByTheme` quando
 * `RunEvalOptions.user` não é passado. O eval mede a QUALIDADE do retrieval
 * (a query certa traz os versos certos), não a política de autorização por
 * usuário — por isso o default tem acesso total (`public` + `curated`): um
 * caso não deveria falhar porque um nível de acesso arbitrário escondeu um
 * `expectedId` que o hard filter legitimamente autorizaria para outro
 * usuário. Casos que precisem exercitar o hard filter por nível de acesso
 * podem sobrescrever via `options.user`.
 */
export const DEFAULT_EVAL_USER: User = { id: "eval-harness", accessLevels: ["public", "curated"] };

export interface RunEvalOptions {
  /** Usuário do hard filter — default `DEFAULT_EVAL_USER` (acesso total). */
  user?: User;
}

/** `haystack` começa EXATAMENTE com `prefix`, na mesma ordem (usado pelo critério `strict`). */
function arrayStartsWith(haystack: readonly CanonicalId[], prefix: readonly CanonicalId[]): boolean {
  if (prefix.length > haystack.length) return false;
  return prefix.every((id, index) => haystack[index] === id);
}

async function evaluateCase(service: RetrievalService, evalCase: EvalCase, user: User): Promise<EvalCaseReport> {
  // `exactOptionalPropertyTypes` (tsconfig base) proíbe atribuir `translation:
  // undefined` explicitamente — só inclui a chave quando o caso realmente
  // declara `translation` (mesmo contorno do `translationFilter` condicional
  // em `search-theme.ts`).
  const searchOptions: ThemeSearchOptions =
    evalCase.translation !== undefined
      ? { translation: evalCase.translation, limit: evalCase.limit }
      : { limit: evalCase.limit };
  const results = await service.searchByTheme(evalCase.query, user, searchOptions);
  // Ranking COMPLETO devolvido pelo serviço, sem a truncagem defensiva abaixo
  // — usado só por `firstExpectedRank` (métrica de progresso que não pode
  // ficar artificialmente capada pelo `limit` do caso, ver docstring do schema).
  const fullRanking = results.map((result) => result.canonicalId);
  // Truncagem defensiva em `limit`: `searchByTheme` já aplica `LIMIT` na SQL,
  // mas o harness não confia cegamente num `RetrievalService` arbitrário
  // (fakes de teste inclusive) — o critério é sempre sobre o topN declarado
  // no caso, nunca sobre o array cru devolvido.
  const ranking = fullRanking.slice(0, evalCase.limit);
  const missing = evalCase.expectedIds.filter((id) => !ranking.includes(id));

  const passed = evalCase.strict
    ? missing.length === 0 && arrayStartsWith(ranking, evalCase.expectedIds)
    : missing.length === 0;

  const foundInLimitCount = evalCase.expectedIds.filter((id) => ranking.includes(id)).length;
  const recallAtLimit = foundInLimitCount / evalCase.expectedIds.length;

  const expectedIdSet = new Set(evalCase.expectedIds);
  const firstExpectedIndex = fullRanking.findIndex((id) => expectedIdSet.has(id));
  const firstExpectedRank = firstExpectedIndex === -1 ? null : firstExpectedIndex + 1;

  return evalCaseReportSchema.parse({
    id: evalCase.id,
    passed,
    criterion: evalCase.strict ? "strict" : "coverage",
    missing,
    ranking,
    recallAtLimit,
    firstExpectedRank,
  });
}

/**
 * Roda todos os `cases` contra `service`, em ordem, e devolve o `EvalReport`
 * agregado. Async porque `RetrievalService.searchByTheme` é I/O real (Postgres
 * + sidecar de embedding) — não há caminho síncrono possível aqui.
 */
export async function runEval(
  service: RetrievalService,
  cases: readonly EvalCase[],
  options: RunEvalOptions = {},
): Promise<EvalReport> {
  const user = options.user ?? DEFAULT_EVAL_USER;

  const caseReports: EvalCaseReport[] = [];
  // Série, nunca `Promise.all`: preserva a ordem de `cases` no report
  // (determinismo, ver docstring do módulo) e evita saturar o pool de
  // conexões do Postgres com N queries concorrentes.
  for (const evalCase of cases) {
    // eslint-disable-next-line no-await-in-loop -- serialização é requisito, não descuido.
    caseReports.push(await evaluateCase(service, evalCase, user));
  }

  const passed = caseReports.filter((report) => report.passed).length;
  // `0` quando `caseReports` está vazio — evita `0/0 = NaN` sem introduzir
  // não-determinismo (é aritmética pura sobre os próprios reports).
  const meanRecallAtLimit =
    caseReports.length === 0
      ? 0
      : caseReports.reduce((sum, report) => sum + report.recallAtLimit, 0) / caseReports.length;
  const casesWithExpectedFound = caseReports.filter((report) => report.firstExpectedRank !== null).length;

  return evalReportSchema.parse({
    cases: caseReports,
    total: caseReports.length,
    passed,
    failed: caseReports.length - passed,
    meanRecallAtLimit,
    casesWithExpectedFound,
  });
}
