/**
 * Formato das "perguntas-ouro" do eval de retrieval (Fase 2, N7 — plano
 * `docs/plano-fase2-retrieval.md` §5.1/OQ-3). Cada linha do JSONL de casos
 * descreve uma query e os `canonicalId`s que o retrieval deve trazer.
 *
 * Autocontido de propósito: NÃO importa nada de `packages/retrieval/src/`
 * (o scaffold do pacote — N2 — nasce em paralelo a este nó) — só depende de
 * `@bereia/core` (dependência legítima, ADR-007) para validar `expectedIds`
 * contra `canonicalIdSchema`. O harness real (N8) importa este módulo.
 */

import { canonicalIdSchema } from "@bereia/core";
import { z } from "zod";

/**
 * Identificador do caso de eval — slug curto e estável (usado em relatórios
 * de gate e em mensagens de erro). Kebab-case minúsculo, sem espaços.
 */
export const evalCaseIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id deve ser um slug kebab-case (ex.: mock-tema-a)");

/**
 * Um caso de "pergunta-ouro": `query` é o texto de busca; `expectedIds` são
 * os versos que `searchByTheme` deve trazer (OQ-6, §5.2). `limit` é o N do
 * critério de cobertura (`expectedIds ⊆ topN`); `strict` (opt-in, default
 * `false`) pede exatidão de PREFIXO — os `expectedIds`, na ordem exata, no
 * topo do resultado — em vez de mera cobertura.
 */
export const evalCaseSchema = z.object({
  id: evalCaseIdSchema,
  query: z.string().min(1, "query não pode ser vazia"),
  translation: z.string().min(1).optional(),
  limit: z.number().int().positive().default(10),
  strict: z.boolean().default(false),
  expectedIds: z.array(canonicalIdSchema).min(1, "expectedIds precisa ter ao menos 1 canonical_id"),
  note: z.string().min(1, "note não pode ser vazia — documenta a intenção/autoria do caso"),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/**
 * Lê o conteúdo de um arquivo de perguntas-ouro (uma linha JSON por caso,
 * terminado em LF — mesmo formato do JSONL canônico de `ingestion/load/jsonl.ts`,
 * reimplementado aqui de propósito para não acoplar `retrieval → ingestion`,
 * ADR-007). Explode cedo com o NÚMERO DA LINHA em qualquer malformação:
 * JSON inválido, linha vazia, schema reprovado, ou `id` duplicado no arquivo
 * (duplicar id quebraria relatórios de gate e a correlação snapshot→caso).
 */
export function parseEvalCasesJsonl(content: string): EvalCase[] {
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new Error("parseEvalCasesJsonl: conteúdo não termina com LF (formato JSONL inválido)");
  }

  const lines = content.slice(0, -1).split("\n");
  const seenIds = new Set<string>();

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0) {
      throw new Error(`parseEvalCasesJsonl: linha ${lineNumber} vazia`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `parseEvalCasesJsonl: linha ${lineNumber} não é JSON válido — ${(error as Error).message}`,
      );
    }

    const result = evalCaseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`parseEvalCasesJsonl: linha ${lineNumber} inválida — ${result.error.message}`);
    }

    const evalCase = result.data;
    if (seenIds.has(evalCase.id)) {
      throw new Error(`parseEvalCasesJsonl: id "${evalCase.id}" duplicado (linha ${lineNumber})`);
    }
    seenIds.add(evalCase.id);

    return evalCase;
  });
}
