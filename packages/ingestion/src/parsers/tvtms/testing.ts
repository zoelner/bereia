import type { TvtmsRef } from "./refs.js";
import type { SourceInventory } from "./tests-grammar.js";
import type { StandardInventory } from "./mapper.js";

/**
 * Inventários sintéticos para testes — descrevem Bíblias SIMULADAS
 * (estrutura de capítulos/versos mock, sem conteúdo teológico real).
 */
export interface ChapterSpec {
  /** Último verso do capítulo na fonte simulada. */
  last: number;
  /** Há texto (título de Salmo) antes do v.1? */
  title?: boolean;
  /** Contagem de palavras por verso; default 10. */
  words?: Record<number, number>;
  /** Versos ausentes (ex.: At 8:37 em texto crítico). */
  missing?: number[];
}

/** Chaveado por código de livro TVTMS ("Psa"), como nas refs dos Tests. */
export type InventorySpec = Record<string, Record<number, ChapterSpec>>;

export function fakeInventory(spec: InventorySpec): SourceInventory {
  const chapterOf = (ref: TvtmsRef): ChapterSpec | undefined =>
    typeof ref.chapter === "number" ? spec[ref.book]?.[ref.chapter] : undefined;
  return {
    exists(ref) {
      const ch = chapterOf(ref);
      if (ch === undefined || ref.subverse !== null) return false;
      if (ref.verse === "Title") return ch.title === true;
      return ref.verse >= 1 && ref.verse <= ch.last && !(ch.missing ?? []).includes(ref.verse);
    },
    isLast(ref) {
      const ch = chapterOf(ref);
      return ch !== undefined && ref.subverse === null && ref.verse === ch.last;
    },
    wordCount(ref) {
      const ch = chapterOf(ref);
      if (ch === undefined || ref.subverse !== null || ref.verse === "Title") return 0;
      if ((ch.missing ?? []).includes(ref.verse) || ref.verse > ch.last) return 0;
      return ch.words?.[ref.verse] ?? 10;
    },
    hasTextBeforeV1(book, chapter) {
      return typeof chapter === "number" && spec[book]?.[chapter]?.title === true;
    },
  };
}

/** Versificação-mestre simulada: capítulos não declarados têm `fallback` versos. */
export function fakeStandardInventory(
  spec: Record<string, Record<number, number>> = {},
  fallback = 176,
): StandardInventory {
  return {
    lastVerse(book, chapter) {
      return spec[book]?.[chapter] ?? fallback;
    },
  };
}
