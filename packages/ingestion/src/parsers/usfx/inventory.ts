import type { UsfmBook } from "@bereia/core";
import { TVTMS_TO_USFM } from "../tvtms/books.js";
import type { SourceInventory } from "../tvtms/tests-grammar.js";
import type { StandardInventory } from "../tvtms/mapper.js";
import type { TvtmsRef } from "../tvtms/refs.js";
import type { UsfxBible, UsfxChapter } from "./parser.js";

/**
 * Adaptadores: Bíblia USFX parseada → inventários que o mapper TVTMS consome.
 * Aqui os casos-ouro deixam de rodar contra Bíblias simuladas e passam a
 * rodar contra a estrutura REAL das fontes.
 */

function chapterOf(bible: UsfxBible, ref: TvtmsRef): UsfxChapter | undefined {
  const usfm = TVTMS_TO_USFM[ref.book];
  if (usfm === undefined || typeof ref.chapter !== "number") return undefined;
  return bible.books.get(usfm)?.get(ref.chapter);
}

/** Semântica alinhada aos Tests do TVTMS: "existe" = tem texto canônico. */
export function usfxSourceInventory(bible: UsfxBible): SourceInventory {
  return {
    exists(ref) {
      const ch = chapterOf(bible, ref);
      if (ch === undefined || ref.subverse !== null) return false;
      if (ref.verse === "Title") return ch.title !== null && ch.title !== "";
      return (ch.verses.get(ref.verse)?.text ?? "") !== "";
    },
    isLast(ref) {
      const ch = chapterOf(bible, ref);
      return (
        ch !== undefined &&
        ref.subverse === null &&
        typeof ref.verse === "number" &&
        ref.verse === ch.lastVerse
      );
    },
    wordCount(ref) {
      const ch = chapterOf(bible, ref);
      if (ch === undefined || ref.subverse !== null) return 0;
      const text = ref.verse === "Title" ? (ch.title ?? "") : (ch.verses.get(ref.verse)?.text ?? "");
      return text === "" ? 0 : text.split(" ").length;
    },
    hasTextBeforeV1(book, chapter) {
      const ch = chapterOf(bible, { book, chapter, verse: 1, subverse: null });
      return ch !== undefined && ch.title !== null && ch.title !== "";
    },
  };
}

/** Contagem de versos da versificação-mestre (usar com a KJV parseada). */
export function usfxStandardInventory(bible: UsfxBible): StandardInventory {
  return {
    lastVerse(book, chapter) {
      const last = bible.books.get(book as UsfmBook)?.get(chapter)?.lastVerse;
      if (last === undefined) {
        throw new Error(`versificação-mestre sem ${book} ${chapter} — inventário incompleto`);
      }
      return last;
    },
  };
}
