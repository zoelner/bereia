/**
 * Build FINAL de `edges` (N7 do plano de fechamento da Fase 1, §3.2/§4).
 * Função PURA: recebe a saída do parser de cross-references (N2 —
 * `parseXrefs`) e o inventário canônico-mestre (N5 — `buildCanonicalVerses`
 * sobre a KJV) e devolve o conjunto de `Edge` `kind:"tsk"` pronto para o
 * JSONL canônico. Não lê disco nem rede.
 *
 * ## O que N2 entrega (LIGAR, não reimplementar)
 * - `edges`: cross-refs verso→verso já expandidas (singles + ranges
 *   INTRA-capítulo), deduplicadas e ordenadas. Inclui self-loops de expansão
 *   (`Gen.1.2\tGen.1.1-Gen.1.3` gera `GEN_1_2→GEN_1_2`).
 * - `deferredRanges`: ranges INTER-capítulo/INTER-livro que o parser NÃO pode
 *   expandir sem o inventário de versos da KJV (`{sourceId, targetStartId,
 *   targetEndId}`). São delegados aqui (§3.2 do plano).
 *
 * ## Semântica deste nó (herança documentada de N2)
 * - **Expandir os `deferredRanges` contra o inventário-mestre:** todo
 *   `canonical_id` do mestre ENTRE `targetStartId` e `targetEndId` na ordem
 *   canônica (comparadores do N4) vira um alvo. Os endpoints `start`/`end` são
 *   apenas âncoras de intervalo — a enumeração sai do inventário, então todo
 *   alvo expandido EXISTE no mestre por construção.
 * - **Verso 0 (título de Salmo, OQ-2) NÃO entra como alvo** (orientação do
 *   dono): as cross-refs da OpenBible referenciam CORPOS de verso (o corpo do
 *   Salmo começa em v.1, convenção inglesa; zero refs a `.0` no corpus — N2).
 *   Um título que caia no miolo de um range é PULADO com contagem
 *   (`skippedTitlesInRanges`), nunca silenciosamente.
 * - **Self-loops removidos com estatística:** toda edge `source == target`
 *   (as de N2 + as que a expansão de range possa criar quando o `source` cai
 *   dentro do próprio intervalo de destino) é degenerada e sai — reportada em
 *   `selfLoopsRemoved`.
 * - **Endpoints inexistentes no mestre → descarte com estatística (OQ-4):**
 *   uma edge cujo `sourceId` OU `targetId` não esteja no inventário-mestre é
 *   descartada e contada (`discardedOutOfMaster`). Fonte real: no corpus atual
 *   há exatamente 1 residual NRSV↔KJV — 3Jo 1:15 como source (a KJV-mestre
 *   encerra 3João no v.14); refs como 2Co 13:14 RESOLVEM no mestre. O build FALHA
 *   ruidosamente se a taxa passar do teto (`DEFAULT_MAX_DISCARD_RATE`, ~0,5%)
 *   — indica drift de versificação/book-map, não residual esperado.
 * - **Precedência FK antes de self-loop:** o descarte por endpoint fora do
 *   mestre é a invariante de produto (toda edge aponta para ids existentes);
 *   ele é aplicado ANTES da remoção de self-loop. Uma edge `s==t` com `s` fora
 *   do mestre conta como descarte, não como self-loop.
 *
 * ## Determinismo (requisito de produto — CLAUDE.md §1/§7)
 * - Índice do mestre ordenado internamente pelos comparadores do N4 — não
 *   confia na ordem de entrada.
 * - Pares candidatos deduplicados via `Set`; contagens independem da ordem de
 *   iteração; saída final ordenada por `edgeSortKeyOf`/`compareEdgeKey` (N4).
 * - Invariante final asserida no teste: toda edge tem `sourceId`/`targetId ∈`
 *   inventário-mestre e `sourceId != targetId`.
 */

import { parseCanonicalId } from "@bereia/core";
import type { CanonicalId, CanonicalRef, CanonicalVerse, Edge } from "@bereia/core";
import type { XrefDeferredRange } from "../parsers/xrefs/parser.js";
import {
  compareCanonicalRef,
  compareEdgeKey,
  edgeSortKeyOf,
  sortDeterministic,
  sortDeterministicBy,
} from "./order.js";

/** Teto da taxa de descarte de endpoints fora do mestre (OQ-4): 0,5%. Acima, explode. */
export const DEFAULT_MAX_DISCARD_RATE = 0.005;

export interface BuildEdgesInput {
  /** Edges diretas de `parseXrefs` (singles + ranges intra-capítulo, self-loops inclusos). */
  edges: readonly Edge[];
  /** Ranges inter-capítulo/inter-livro de `parseXrefs`, expandidos aqui. */
  deferredRanges: readonly XrefDeferredRange[];
  /** Inventário-mestre (saída de `buildCanonicalVerses`) — FK + fonte da expansão de range. */
  inventory: readonly CanonicalVerse[];
  /** Teto de taxa de descarte (OQ-4). Default `DEFAULT_MAX_DISCARD_RATE`. */
  maxDiscardRate?: number;
}

export interface BuildEdgesStats {
  /** Edges diretas recebidas de N2 (já deduplicadas). */
  directEdges: number;
  /** `deferredRanges` recebidos de N2. */
  deferredRanges: number;
  /** Alvos gerados pela expansão dos ranges (bruto, antes do dedupe global). */
  expandedFromDeferred: number;
  /** Títulos (verso 0) pulados no miolo dos ranges (OQ-2) — não viram alvo. */
  skippedTitlesInRanges: number;
  /** Pares `(source,target)` únicos candidatos (diretos ∪ expandidos), antes de descarte/self-loop. */
  candidateEdges: number;
  /** Candidatos descartados por endpoint fora do inventário-mestre (OQ-4). */
  discardedOutOfMaster: number;
  /** `discardedOutOfMaster / candidateEdges`. */
  discardRate: number;
  /** Teto aplicado (auditoria). */
  discardCeiling: number;
  /** Self-loops (`source == target`) removidos, entre os candidatos válidos. */
  selfLoopsRemoved: number;
  /** Edges no conjunto FINAL (candidatos válidos, não self-loop, deduplicados). */
  finalEdges: number;
}

export interface BuildEdgesResult {
  /** Conjunto final de edges `kind:"tsk"`, ordenado (comparadores do N4). */
  edges: Edge[];
  stats: BuildEdgesStats;
}

/**
 * Primeiro índice de `sorted` cujo ref é `>= target` (lower bound). `sorted`
 * está em ordem canônica total (`compareCanonicalRef`).
 */
function lowerBound(sorted: readonly CanonicalRef[], target: CanonicalRef): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareCanonicalRef(sorted[mid] as CanonicalRef, target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Primeiro índice de `sorted` cujo ref é `> target` (upper bound). */
function upperBound(sorted: readonly CanonicalRef[], target: CanonicalRef): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareCanonicalRef(sorted[mid] as CanonicalRef, target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Constrói o conjunto FINAL de edges. Ver o cabeçalho do módulo para a
 * semântica completa (expansão de range, verso 0, self-loop, descarte OQ-4).
 */
export function buildEdges(input: BuildEdgesInput): BuildEdgesResult {
  const { edges, deferredRanges, inventory } = input;
  const maxDiscardRate = input.maxDiscardRate ?? DEFAULT_MAX_DISCARD_RATE;

  // Índice do inventário-mestre: conjunto para FK + array ordenado (N4) para a
  // expansão de range por busca binária. Ordenação interna → independe da ordem
  // de entrada (determinismo).
  const masterSet = new Set<CanonicalId>(inventory.map((v) => v.id));
  const masterSorted = sortDeterministic(inventory, compareCanonicalRef);

  // Pares candidatos únicos "source\ttarget": diretos (já deduplicados por N2)
  // + expandidos dos deferredRanges. `Set` garante dedupe determinístico.
  const candidates = new Set<string>();
  for (const edge of edges) candidates.add(`${edge.sourceId}\t${edge.targetId}`);

  let expandedFromDeferred = 0;
  let skippedTitlesInRanges = 0;
  for (const range of deferredRanges) {
    const startRef = parseCanonicalId(range.targetStartId);
    const endRef = parseCanonicalId(range.targetEndId);
    if (compareCanonicalRef(startRef, endRef) > 0) {
      throw new Error(
        `buildEdges: deferredRange decrescente ${range.sourceId} → ` +
          `${range.targetStartId}..${range.targetEndId} — ordem canônica invertida (upstream inesperado)`,
      );
    }
    const from = lowerBound(masterSorted, startRef);
    const to = upperBound(masterSorted, endRef);
    for (let k = from; k < to; k++) {
      const verse = masterSorted[k] as CanonicalVerse;
      if (verse.verse === 0) {
        // Título de Salmo (OQ-2) no miolo do range: a OpenBible referencia
        // corpos de verso — pula com contagem, nunca vira alvo.
        skippedTitlesInRanges++;
        continue;
      }
      expandedFromDeferred++;
      candidates.add(`${range.sourceId}\t${verse.id}`);
    }
  }

  // Classificação única por par candidato: FK (invariante de produto) primeiro,
  // self-loop depois. Determinística (contagens independem da iteração do Set).
  const kept: Edge[] = [];
  let discardedOutOfMaster = 0;
  let selfLoopsRemoved = 0;
  for (const key of candidates) {
    const [sourceId, targetId] = key.split("\t") as [CanonicalId, CanonicalId];
    if (!masterSet.has(sourceId) || !masterSet.has(targetId)) {
      discardedOutOfMaster++;
      continue;
    }
    if (sourceId === targetId) {
      selfLoopsRemoved++;
      continue;
    }
    kept.push({ sourceId, targetId, kind: "tsk" });
  }

  const candidateEdges = candidates.size;
  const discardRate = candidateEdges === 0 ? 0 : discardedOutOfMaster / candidateEdges;
  if (discardRate > maxDiscardRate) {
    throw new Error(
      `buildEdges: taxa de descarte fora-do-mestre ${(discardRate * 100).toFixed(3)}% > teto ` +
        `${(maxDiscardRate * 100).toFixed(3)}% (${discardedOutOfMaster}/${candidateEdges}) — ` +
        `provável drift de versificação/book-map, não residual esperado (OQ-4)`,
    );
  }

  const finalEdges = sortDeterministicBy(kept, edgeSortKeyOf, compareEdgeKey);
  return {
    edges: finalEdges,
    stats: {
      directEdges: edges.length,
      deferredRanges: deferredRanges.length,
      expandedFromDeferred,
      skippedTitlesInRanges,
      candidateEdges,
      discardedOutOfMaster,
      discardRate,
      discardCeiling: maxDiscardRate,
      selfLoopsRemoved,
      finalEdges: finalEdges.length,
    },
  };
}
