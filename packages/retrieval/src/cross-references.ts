/**
 * Referências cruzadas via recursive CTE (N5 do plano, §3.3/§6.1). Implementa
 * a consulta que satisfaz `RetrievalService.getCrossReferences` do core
 * (`packages/core/src/retrieval.ts`, INTOCADO por este nó) — a composição em
 * `PgRetrieval` (N6) chama `getCrossReferences` daqui passando a conexão
 * `sql` já aberta.
 *
 * ## Profundidade (OQ-2 do plano — teto=3, default=1)
 * `maxHops` runtime default 1; teto absoluto 3 (alinhado ao `maxHops ≤ 3`
 * hardcoded no stub do mcp-server e à decisão "Neo4j só se >3 saltos virarem
 * requisito validado", CLAUDE.md §2). Passar `maxHops > 3` EXPLODE com
 * mensagem clara — nunca clampa em silêncio (determinismo de contrato:
 * clampar mudaria o resultado sem avisar o chamador).
 *
 * ## Anti-ciclo e explosão (grafo real: 614.208 edges kind 'tsk', sem
 * self-loops, mas com ciclos A→B→A por construção — cross-refs bidirecionais)
 * A CTE recursiva rastreia `(id, hop)` e usa `UNION` (não `UNION ALL`): o
 * motor do Postgres deduplica cada par `(id, hop)` já materializado antes de
 * expandir — isso é o que impede o loop (A→B→A não reprocessa `A` no mesmo
 * `hop` em que já foi alcançado) e, por construção, LIMITA matematicamente o
 * tamanho da CTE a no máximo `nós_do_grafo × (maxHops+1)` linhas — mesmo num
 * grafo denso, sem precisar carregar o caminho completo por linha (que
 * cresceria combinatoriamente). Além dessa garantia estrutural, uma checagem
 * explícita pós-query (`maxVisitedNodes`, default generoso, override em
 * teste) explode com erro claro se o conjunto de versos alcançados for maior
 * do que o esperado para qualquer uso são do produto — proteção contra grafo
 * futuro muito mais denso, não uma otimização de performance (essas ficam de
 * backlog, plano §2.3/§8).
 *
 * A recursão também exclui explicitamente `target_id = canonicalId` (o
 * próprio verso de partida): sem essa exclusão, um ciclo A→B→A faria o verso
 * de partida "se referenciar" via um hop maior, o que não é uma cross-
 * reference de fato — é apenas o grafo voltando à origem.
 *
 * ## Hard filter (CLAUDE.md §5) — aplicado DENTRO da recursão
 * `canon_status='protestant'` e `authorized_levels ⊇ accessLevels do user`
 * (overlap, "&&") são condições da PRÓPRIA CTE recursiva — um verso não
 * autorizado nunca entra em `reached`, então nem aparece no resultado nem é
 * usado para continuar a expansão (uma cross-ref só visível através de um nó
 * não autorizado também não vaza). Se o verso de partida (`canonicalId`) não
 * é autorizado, o caso-base fica vazio e a função devolve `[]` — espelha o
 * `null` de `getVerse`/`getExegesis` para verso não autorizado, mas `Edge[]`
 * não é nullable no port, então o "vazio" é a resposta análoga.
 *
 * ## Ordem de saída — total e estável
 * `hop` ascendente, depois `sourceId`, `targetId`, `kind` (ordem canônica de
 * string) — chave total (nunca há empate), logo determinística entre execuções
 * (§3.3/§4 do plano).
 */

import type postgres from "postgres";
import { z } from "zod";
import { canonicalIdSchema, edgeSchema, type CanonicalId, type CrossReferenceOptions, type Edge, type User } from "@bereia/core";

/** Runtime default do plano (OQ-2). */
export const DEFAULT_MAX_HOPS = 1;
/** Teto absoluto do plano (OQ-2) — maxHops>3 explode, nunca clampa. */
export const MAX_HOPS_CEILING = 3;
/**
 * Teto interno de nós visitados, default generoso (o corpus real tem ~31k
 * versos e 614.208 edges — um `maxHops=3` a partir de um verso comum não
 * chega perto disso). Existe para nunca devolver um resultado truncado sem
 * avisar: se o conjunto alcançado ultrapassa o teto, a função EXPLODE (nunca
 * corta em silêncio). Sobrescrevível via `options.maxVisitedNodes` — usado
 * pelos testes para pinar o comportamento de explosão com fixtures pequenas.
 */
export const DEFAULT_MAX_VISITED_NODES = 5000;

export interface GetCrossReferencesOptions extends CrossReferenceOptions {
  /** Usuário do hard filter (`accessLevels`) — obrigatório, sem hardcode. */
  user: User;
  /** Teto interno de nós visitados antes de explodir (ver `DEFAULT_MAX_VISITED_NODES`). */
  maxVisitedNodes?: number;
  /**
   * LIMIT determinístico do resultado final (aplicado DEPOIS da ordenação
   * total, então "os N primeiros" é sempre o mesmo conjunto/ordem — corte
   * silencioso aqui é seguro, ao contrário do teto de explosão acima).
   */
  limit?: number;
}

// --- validação de maxHops (explode, nunca clampa) ---------------------------

function resolveMaxHops(maxHops: number | undefined): number {
  const value = maxHops ?? DEFAULT_MAX_HOPS;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`getCrossReferences: maxHops deve ser um inteiro ≥ 1 (recebido ${JSON.stringify(maxHops)})`);
  }
  if (value > MAX_HOPS_CEILING) {
    throw new Error(
      `getCrossReferences: maxHops=${String(value)} excede o teto de ${String(MAX_HOPS_CEILING)} ` +
        "(OQ-2, docs/plano-fase2-retrieval.md) — profundidades maiores exigiriam Neo4j por decisão de " +
        "produto (CLAUDE.md §2, \"Neo4j só se >3 saltos virarem requisito validado\"); reduza maxHops.",
    );
  }
  return value;
}

function resolveLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`getCrossReferences: limit deve ser um inteiro ≥ 1 (recebido ${JSON.stringify(limit)})`);
  }
  return limit;
}

// --- shape interno das duas queries -----------------------------------------

const reachedRowSchema = z.object({
  id: canonicalIdSchema,
  hop: z.number().int().positive(),
});

const rawEdgeRowSchema = z.object({
  source_id: canonicalIdSchema,
  target_id: canonicalIdSchema,
  kind: z.enum(["tsk", "thematic", "manual"]),
});

/**
 * Literal de array do Postgres (`text[]`): `{"a","b"}`, com escape de `\`/`"`
 * — mesmo formato usado em `ingestion/load/postgres.ts#formatTextArray`
 * (duplicação mínima deliberada, `retrieval` não importa de `ingestion`,
 * ADR-007). Passado como STRING + `::text[]` (nunca via `sql.array(...)`):
 * o helper `array()` do driver `postgres` resolve o oid do tipo array de
 * forma assíncrona/lazy (`fetchArrayTypes`, 1ª query com array por conexão) —
 * numa conexão nova, antes dessa resolução completar, o parâmetro pode ser
 * enviado como escalar `text`, e `&&`/`ANY()` explodem ("operator does not
 * exist: text[] && text" ou "malformed array literal"). Enviar o literal já
 * formatado como texto simples elimina essa corrida por completo.
 */
function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

/**
 * Consulta 1: expansão via `WITH RECURSIVE` sobre `edges`, hard filter
 * embutido na própria recursão, anti-ciclo por dedup `(id, hop)` (`UNION`).
 * Devolve o MENOR hop em que cada verso alcançável foi encontrado
 * (`GROUP BY id / MIN(hop)`), excluindo o próprio `canonicalId` (hop=0).
 */
async function queryReachedNodes(
  sql: postgres.Sql,
  canonicalId: CanonicalId,
  accessLevels: readonly string[],
  maxHops: number,
): Promise<{ id: CanonicalId; hop: number }[]> {
  const accessLevelsLiteral = formatTextArrayLiteral([...accessLevels]);
  const rows = await sql<{ id: string; hop: number }[]>`
    WITH RECURSIVE reached(id, hop) AS (
      SELECT cv.id, 0
      FROM canonical_verses cv
      WHERE cv.id = ${canonicalId}
        AND cv.canon_status = 'protestant'
        AND EXISTS (
          SELECT 1 FROM verse_texts vt
          WHERE vt.canonical_id = cv.id AND vt.authorized_levels && ${accessLevelsLiteral}::text[]
        )
      UNION
      SELECT e.target_id, r.hop + 1
      FROM edges e
      JOIN reached r ON e.source_id = r.id
      JOIN canonical_verses cv ON cv.id = e.target_id
      WHERE r.hop < ${maxHops}
        AND e.target_id <> ${canonicalId} -- o próprio verso de partida nunca "referencia a si mesmo" via ciclo
        AND cv.canon_status = 'protestant'
        AND EXISTS (
          SELECT 1 FROM verse_texts vt
          WHERE vt.canonical_id = e.target_id AND vt.authorized_levels && ${accessLevelsLiteral}::text[]
        )
    )
    SELECT id, MIN(hop) AS hop
    FROM reached
    WHERE hop > 0
    GROUP BY id
  `;
  return rows.map((row) => reachedRowSchema.parse(row));
}

/**
 * Consulta 2 (não-recursiva): busca as edges reais entre `canonicalId`∪
 * `reached` (fontes) e `reached` (alvos) — a filtragem final "edge pertence
 * ao caminho de menor hop" acontece em memória (`hop[target] === hop[source]+1`,
 * tratando `canonicalId` como hop=0), porque o conjunto já é pequeno (bounded
 * pelo teto de nós visitados) e mantém a query simples/parametrizada.
 */
async function queryCandidateEdges(
  sql: postgres.Sql,
  canonicalId: CanonicalId,
  reachedIds: readonly CanonicalId[],
): Promise<{ source_id: string; target_id: string; kind: string }[]> {
  const sources = [canonicalId, ...reachedIds];
  return sql<{ source_id: string; target_id: string; kind: string }[]>`
    SELECT source_id, target_id, kind
    FROM edges
    WHERE target_id = ANY(${formatTextArrayLiteral([...reachedIds])}::text[])
      AND source_id = ANY(${formatTextArrayLiteral([...sources])}::text[])
  `;
}

/**
 * Referências cruzadas de `canonicalId` via recursive CTE sobre `edges`
 * (§3.3 do plano). Ver documentação do módulo para as invariantes de
 * determinismo, anti-ciclo, hard filter e explosão.
 */
export async function getCrossReferences(
  sql: postgres.Sql,
  canonicalId: CanonicalId,
  options: GetCrossReferencesOptions,
): Promise<Edge[]> {
  const parsedCanonicalId = canonicalIdSchema.parse(canonicalId);
  const maxHops = resolveMaxHops(options.maxHops);
  const limit = resolveLimit(options.limit);
  const maxVisitedNodes = options.maxVisitedNodes ?? DEFAULT_MAX_VISITED_NODES;
  if (!Number.isInteger(maxVisitedNodes) || maxVisitedNodes < 1) {
    throw new Error(
      `getCrossReferences: maxVisitedNodes deve ser um inteiro ≥ 1 (recebido ${JSON.stringify(options.maxVisitedNodes)})`,
    );
  }

  const reached = await queryReachedNodes(sql, parsedCanonicalId, options.user.accessLevels, maxHops);

  if (reached.length > maxVisitedNodes) {
    throw new Error(
      `getCrossReferences: expansão de "${parsedCanonicalId}" (maxHops=${String(maxHops)}) alcançou ` +
        `${String(reached.length)} verso(s), acima do teto interno maxVisitedNodes=${String(maxVisitedNodes)} — ` +
        "reduza maxHops ou aumente o teto explicitamente (nunca corta o resultado em silêncio).",
    );
  }

  if (reached.length === 0) return [];

  const hopById = new Map<string, number>(reached.map((row) => [row.id, row.hop]));
  const reachedIds = reached.map((row) => row.id);
  const candidateEdges = await queryCandidateEdges(sql, parsedCanonicalId, reachedIds);

  const edges: Edge[] = [];
  for (const raw of candidateEdges) {
    const parsed = rawEdgeRowSchema.parse(raw);
    const targetHop = hopById.get(parsed.target_id);
    if (targetHop === undefined) continue; // defensivo — não deveria acontecer (target sempre está em `reached`)
    const sourceHop = parsed.source_id === parsedCanonicalId ? 0 : hopById.get(parsed.source_id);
    if (sourceHop === undefined) continue; // fonte fora do conjunto alcançado — não faz parte de nenhum caminho de menor hop
    if (sourceHop !== targetHop - 1) continue; // edge não pertence ao caminho de MENOR hop até o alvo
    edges.push(edgeSchema.parse({ sourceId: parsed.source_id, targetId: parsed.target_id, kind: parsed.kind }));
  }

  edges.sort((a, b) => {
    const hopDiff = (hopById.get(a.targetId) ?? 0) - (hopById.get(b.targetId) ?? 0);
    if (hopDiff !== 0) return hopDiff;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });

  return limit !== undefined ? edges.slice(0, limit) : edges;
}
