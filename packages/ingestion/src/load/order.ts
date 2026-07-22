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
 * Comparação ordinal (code point a code point) de strings — determinística
 * e independente de locale/ICU do ambiente de execução (`localeCompare`
 * varia entre plataformas e É fonte de não-determinismo, por isso não é
 * usado aqui).
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

/** Mesma ordem de `compareCanonicalRef`, a partir do `canonical_id` bruto (ex.: `sourceId`/`targetId` de `edges`). */
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

/** `edges.jsonl`: `sourceId` → `targetId` → `kind` (plano §3.3). */
export function compareEdge(a: Edge, b: Edge): number {
  return chain(
    compareCanonicalId(a.sourceId, b.sourceId),
    compareCanonicalId(a.targetId, b.targetId),
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
