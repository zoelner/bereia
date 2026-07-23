/**
 * Busca temática exata sobre `verse_texts` (N3 do plano da Fase 2, §3.2/§4).
 * Implementa a CONSULTA que satisfaz `RetrievalService.searchByTheme` do core
 * (`packages/core/src/retrieval.ts`, INTOCADO por este nó) — a composição com
 * o port completo (traduzir `User` já pronto, injetar conexão real) é
 * responsabilidade do N6 (`PgRetrieval`); aqui não se importa nada de fora de
 * `@bereia/core`, do driver `postgres` e do `QueryEmbedder` (N2).
 *
 * ## Determinismo do ranking (CLAUDE.md §2, plano §4)
 * A query embeda com o MESMO build pinado (trava ADR-005 já mora no
 * `QueryEmbedder`), então o vetor de busca vive no mesmo espaço dos vetores
 * do corpus. O ranking é EXATO — sem índice ANN, sem recall probabilístico —
 * `ORDER BY vt.embedding <=> $vector::vector, vt.canonical_id, vt.translation`:
 * a chave de desempate é TOTAL (PK composta de `verse_texts`), então mesmo
 * quando duas linhas empatam bit-a-bit na distância, a ordem de saída nunca
 * varia entre execuções.
 *
 * ## Hard filter ANTES do ranking (CLAUDE.md §5, plano §3.2)
 * `canon_status='protestant'` (join com `canonical_verses`) e
 * `authorized_levels && accessLevels` (overlap) são condições do `WHERE` —
 * nunca pós-processamento. Um verso não autorizado (ou deuterocanônico,
 * fora do MVP) nunca entra no conjunto ranqueado, mesmo sendo o mais
 * próximo vetorialmente.
 *
 * ## `embedding IS NULL` — excluído do ranking
 * Linhas ainda não embedadas (`vt.embedding IS NULL`) são excluídas
 * explicitamente no `WHERE` — não é possível calcular `<=>` contra `NULL`
 * (o operador devolveria `NULL`, que o Postgres ordena de forma
 * incoerente com o requisito de determinismo do produto).
 *
 * ## Vetor da query como PARÂMETRO (nunca interpolação)
 * O literal do tipo `vector` (`[v1,v2,...]`) é formatado como STRING e
 * passado como parâmetro com cast `::vector` — mesmo padrão de
 * `ingestion/load/postgres.ts#formatVector`. O array de `authorized_levels`
 * segue o mesmo contorno do `cross-references.ts`: literal `{"a","b"}`
 * formatado como STRING + `::text[]` (nunca `sql.array(...)`), porque o
 * helper `array()` do driver resolve o oid do tipo de forma assíncrona/lazy
 * — numa conexão nova, antes dessa resolução completar, `&&` explodiria
 * ("operator does not exist: text[] && text").
 */

import type postgres from "postgres";
import { z } from "zod";
import { canonicalIdSchema, type ThemeSearchOptions, type ThemeSearchResult, type User } from "@bereia/core";
import type { QueryEmbedder } from "./embedder.js";

/** Default explícito de `limit` quando `options.limit` não é passado (OQ-6 do plano). */
export const DEFAULT_LIMIT = 10;

export interface SearchByThemeOptions extends ThemeSearchOptions {
  /** Usuário do hard filter (`accessLevels`) — obrigatório, sem hardcode (espelha N4/N5). */
  user: User;
}

// --- formatação de valores para o driver `postgres` (mesmo contorno do resto do pacote) ---

/** Literal de texto do tipo `vector` do pgvector: `[v1,v2,...]` (sem espaço). */
function formatVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

/** Literal de array do Postgres (`text[]`): `{"a","b"}`, com escape de `\`/`"`. */
function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

function resolveLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`searchByTheme: limit deve ser um inteiro ≥ 1 (recebido ${JSON.stringify(limit)})`);
  }
  return value;
}

// --- shape da linha crua retornada pelo driver (snake_case do Postgres) ----

const searchByThemeRowSchema = z.object({
  canonical_id: canonicalIdSchema,
  translation: z.string().min(1),
  text: z.string().min(1),
  distance: z.number(),
});

/**
 * Busca temática de `query` sob o hard filter de `options.user.accessLevels`
 * (§3.2 do plano). Query vazia/whitespace explode ANTES de qualquer embed —
 * não é uma condição excepcional silenciosa, é um erro claro de chamada.
 */
export async function searchByTheme(
  sql: postgres.Sql,
  embedder: QueryEmbedder,
  query: string,
  options: SearchByThemeOptions,
): Promise<ThemeSearchResult[]> {
  if (query.trim().length === 0) {
    throw new Error("searchByTheme: query vazia — nada para buscar (bug de chamada, não deveria acontecer)");
  }
  if (options.user.accessLevels.length === 0) {
    throw new Error(
      "searchByTheme: options.user.accessLevels vazio — hard filter sem nenhum nível autorizado não " +
        "devolveria nenhum texto por definição; passe ao menos um nível (bug de chamada, não deveria acontecer)",
    );
  }

  const limit = resolveLimit(options.limit);
  const vector = await embedder.embedQuery(query);
  const vectorLiteral = formatVectorLiteral(vector);
  const accessLevelsLiteral = formatTextArrayLiteral([...options.user.accessLevels]);

  const translationFilter =
    options.translation !== undefined ? sql`AND vt.translation = ${options.translation}` : sql``;

  const rows = await sql<{ canonical_id: string; translation: string; text: string; distance: number }[]>`
    SELECT vt.canonical_id, vt.translation, vt.text,
           vt.embedding <=> ${vectorLiteral}::vector AS distance
    FROM verse_texts vt
    JOIN canonical_verses cv ON cv.id = vt.canonical_id
    WHERE vt.embedding IS NOT NULL
      AND cv.canon_status = 'protestant'
      AND vt.authorized_levels && ${accessLevelsLiteral}::text[]
      ${translationFilter}
    ORDER BY vt.embedding <=> ${vectorLiteral}::vector, vt.canonical_id, vt.translation
    LIMIT ${limit}
  `;

  return rows.map((row) => {
    const parsed = searchByThemeRowSchema.parse(row);
    const result: ThemeSearchResult = {
      canonicalId: parsed.canonical_id,
      translation: parsed.translation,
      text: parsed.text,
      distance: parsed.distance,
    };
    return result;
  });
}
