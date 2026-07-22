/**
 * Ordenação canônica dos registros do JSONL (`data/canonical/`, ADR-006/§3.3
 * do plano de fechamento da Fase 1). Determinismo é requisito de produto
 * (CLAUDE.md §1/§7): a mesma entrada — em qualquer ordem — precisa produzir
 * sempre a MESMA ordem de saída, para `git diff` estável entre builds (N8).
 *
 * Regra global (plano §3.3): livro (ordem do cânon protestante, `USFM_BOOKS`
 * do core) → capítulo → verso (o verso 0 do título de Salmo ordena antes do
 * verso 1 por construção — comparação numérica simples). Cada tabela
 * acrescenta seu desempate final (`translation`, `position`, `language+id`,
 * `kind`).
 *
 * Cada comparador aqui é uma ordem TOTAL sobre a chave de identidade da
 * tabela: dois registros com a mesma chave (mesmo `canonicalId`+`translation`
 * etc.) SEMPRE comparam igual, e a ordem nativa `Array.prototype.sort`
 * (estável desde ES2019) devolve a mesma sequência independente da ordem de
 * entrada — testado em `order.test.ts` via permutações do mesmo conjunto.
 */

import { parseCanonicalId, USFM_BOOKS } from "@bereia/core";
import type {
  CanonicalId,
  CanonicalRef,
  CanonicalVerse,
  Edge,
  EdgeKind,
  OriginalWord,
  StrongsEntry,
  UsfmBook,
  VerseText,
} from "@bereia/core";

export type Comparator<T> = (a: T, b: T) => number;

/**
 * Combina resultados de comparação em cascata: devolve o primeiro
 * resultado não-zero (desempate), ou 0 se todos empatarem.
 */
export function chain(...results: readonly number[]): number {
  for (const result of results) {
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * Comparação ordinal de strings via `<`/`>` — compara code unit UTF-16 a
 * code unit UTF-16 (não code point; par substituto seria dividido em duas
 * unidades de 16 bits), determinística e independente de locale/ICU do
 * ambiente de execução (`localeCompare` varia entre plataformas e É fonte
 * de não-determinismo, por isso não é usado aqui). Correto para o domínio
 * atual (ASCII: translation, id Strong, tags) — fora de ASCII a ordem
 * ainda é determinística, só não corresponde à ordem "visual" de code
 * points fora do BMP.
 */
export function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const BOOK_ORDER: ReadonlyMap<UsfmBook, number> = new Map(USFM_BOOKS.map((book, index) => [book, index]));

function bookIndex(book: UsfmBook): number {
  const index = BOOK_ORDER.get(book);
  if (index === undefined) {
    throw new Error(`compareCanonicalRef: livro fora do cânon USFM_BOOKS: "${book}"`);
  }
  return index;
}

/**
 * Ordem canônica total de uma referência: livro (ordem do cânon, GEN…REV) →
 * capítulo → verso. Verso 0 (título de Salmo, OQ-2) ordena antes do verso 1
 * do mesmo capítulo.
 */
export function compareCanonicalRef(a: CanonicalRef, b: CanonicalRef): number {
  return chain(bookIndex(a.book) - bookIndex(b.book), a.chapter - b.chapter, a.verse - b.verse);
}

/**
 * Mesma ordem de `compareCanonicalRef`, a partir do `canonical_id` bruto
 * (ex.: `sourceId`/`targetId` de `edges`).
 *
 * Custo conhecido: `parseCanonicalId` valida via Zod (regex + `refine`) a
 * cada chamada — usar este comparador direto num `Array.prototype.sort` de
 * O(n) itens custa O(n log n) parses, reparseando o MESMO id várias vezes.
 * Para listas grandes (ex.: `edges.jsonl`, ~340k linhas em N7 build-edges)
 * prefira `sortDeterministicBy(items, keyOf, compareKey)` com uma `keyOf`
 * que chama `parseCanonicalId` uma única vez por item (O(n)) — ver
 * `edgeSortKeyOf`/`compareEdgeKey` abaixo para o caso de `edges`.
 */
export function compareCanonicalId(a: CanonicalId, b: CanonicalId): number {
  return compareCanonicalRef(parseCanonicalId(a), parseCanonicalId(b));
}

/** `canonical_verses.jsonl`: livro → capítulo → verso (chave de identidade da linha). */
export function compareCanonicalVerse(a: CanonicalVerse, b: CanonicalVerse): number {
  return compareCanonicalRef(a, b);
}

/** `verse_texts/{BOOK}.jsonl`: referência canônica → `translation` (asc, ordinal). */
export function compareVerseText(a: VerseText, b: VerseText): number {
  return chain(compareCanonicalId(a.canonicalId, b.canonicalId), compareOrdinal(a.translation, b.translation));
}

/** `original_words/{BOOK}.jsonl`: referência canônica → `position` (asc). */
export function compareOriginalWord(a: OriginalWord, b: OriginalWord): number {
  return chain(compareCanonicalId(a.canonicalId, b.canonicalId), a.position - b.position);
}

/**
 * Ordem fixa de `language` dentro de `strongs.jsonl` (plano §3.3: ordenado
 * por `(language, id)`) — hebraico (AT) antes de grego (NT), espelhando a
 * ordem do cânon.
 */
const STRONG_LANGUAGE_ORDER: Record<StrongsEntry["language"], number> = {
  hebrew: 0,
  greek: 1,
};

/** `strongs.jsonl`: `language` (hebraico antes de grego) → `id` (ordinal — zero-padded, equivale a numérico). */
export function compareStrongsEntry(a: StrongsEntry, b: StrongsEntry): number {
  return chain(
    STRONG_LANGUAGE_ORDER[a.language] - STRONG_LANGUAGE_ORDER[b.language],
    compareOrdinal(a.id, b.id),
  );
}

/**
 * Ordem fixa de `kind` dentro de `edges.jsonl` — segue a ordem de
 * declaração do `edgeKindSchema` no core (`tsk`, `thematic`, `manual`).
 */
const EDGE_KIND_ORDER: Record<EdgeKind, number> = {
  tsk: 0,
  thematic: 1,
  manual: 2,
};

/**
 * `edges.jsonl`: `sourceId` → `targetId` → `kind` (plano §3.3). Mesmo custo
 * de `parseCanonicalId` por comparação descrito em `compareCanonicalId` —
 * para o volume real de `edges.jsonl` prefira `sortDeterministicBy(edges,
 * edgeSortKeyOf, compareEdgeKey)`, que produz exatamente a mesma ordem.
 */
export function compareEdge(a: Edge, b: Edge): number {
  return chain(
    compareCanonicalId(a.sourceId, b.sourceId),
    compareCanonicalId(a.targetId, b.targetId),
    EDGE_KIND_ORDER[a.kind] - EDGE_KIND_ORDER[b.kind],
  );
}

/** Chave pré-computada de uma `edge` para `sortDeterministicBy` — ver `compareEdgeKey`. */
export interface EdgeSortKey {
  source: CanonicalRef;
  target: CanonicalRef;
  kind: EdgeKind;
}

/**
 * `keyOf` de decorate-sort-undecorate para `edges`: parseia `sourceId`/
 * `targetId` (Zod) UMA vez por item, em vez de a cada comparação do sort
 * (ver custo documentado em `compareCanonicalId`/`compareEdge`).
 */
export function edgeSortKeyOf(edge: Edge): EdgeSortKey {
  return {
    source: parseCanonicalId(edge.sourceId),
    target: parseCanonicalId(edge.targetId),
    kind: edge.kind,
  };
}

/**
 * Compara duas `EdgeSortKey` já decoradas — mesma ordem total de
 * `compareEdge`, sem reparsear `canonical_id`. Uso: `sortDeterministicBy(
 * edges, edgeSortKeyOf, compareEdgeKey)`.
 */
export function compareEdgeKey(a: EdgeSortKey, b: EdgeSortKey): number {
  return chain(
    compareCanonicalRef(a.source, b.source),
    compareCanonicalRef(a.target, b.target),
    EDGE_KIND_ORDER[a.kind] - EDGE_KIND_ORDER[b.kind],
  );
}

/**
 * Ordena `items` de forma determinística segundo `compare` — não muta o
 * array de entrada. A garantia de determinismo depende de `compare` ser uma
 * ordem TOTAL sobre a chave de identidade dos registros (nenhum par
 * distinto compara igual); veja o comentário de topo do módulo.
 */
export function sortDeterministic<T>(items: readonly T[], compare: Comparator<T>): T[] {
  return [...items].sort(compare);
}

/**
 * Variante decorate-sort-undecorate de `sortDeterministic`: computa
 * `keyOf(item)` UMA vez por item (O(n)) antes de ordenar, em vez de deixar
 * o comparador recomputar a chave a cada comparação (O(n log n)) — usar
 * quando `keyOf` não é trivial (ex.: `parseCanonicalId`, que valida via
 * Zod) e a lista é grande o bastante para o custo importar (ex.: `edges`,
 * N7). Mesma ordem total de `compareKey` sobre `keyOf(item)`; não muta o
 * array de entrada.
 */
export function sortDeterministicBy<T, K>(
  items: readonly T[],
  keyOf: (item: T) => K,
  compareKey: Comparator<K>,
): T[] {
  const decorated = items.map((item) => ({ item, key: keyOf(item) }));
  decorated.sort((a, b) => compareKey(a.key, b.key));
  return decorated.map((entry) => entry.item);
}
