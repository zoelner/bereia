import { z } from "zod";

/**
 * Códigos de livro USFM/Paratext (ADR-001). Vocabulário fechado dos 66 livros
 * do cânon protestante; deuterocanônicos entram como extensão futura do enum.
 */
export const OT_BOOKS = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT",
  "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
  "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER",
  "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
  "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
] as const;

export const NT_BOOKS = [
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO",
  "GAL", "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI",
  "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN",
  "3JN", "JUD", "REV",
] as const;

export const USFM_BOOKS = [...OT_BOOKS, ...NT_BOOKS] as const;

export type UsfmBook = (typeof USFM_BOOKS)[number];

export const usfmBookSchema = z.enum(USFM_BOOKS);

/**
 * ID canônico no formato BOOK_CHAPTER_VERSE (ex.: MAT_5_39), já normalizado
 * para a versificação-mestre KJV via TVTMS (ADR-002). Irreversível na prática.
 */
export const CANONICAL_ID_PATTERN = /^([A-Z0-9]{3})_(\d{1,3})_(\d{1,3})$/;

export const canonicalIdSchema = z
  .string()
  .regex(CANONICAL_ID_PATTERN, "canonical_id deve ter o formato BOOK_CHAPTER_VERSE (ex.: MAT_5_39)")
  .refine(
    (id) => usfmBookSchema.safeParse(id.split("_")[0]).success,
    (id) => ({ message: `código de livro desconhecido em "${id}" — esperado código USFM do cânon de 66 livros` }),
  );

export type CanonicalId = z.infer<typeof canonicalIdSchema>;

export interface CanonicalRef {
  book: UsfmBook;
  chapter: number;
  verse: number;
}

export function makeCanonicalId(ref: CanonicalRef): CanonicalId {
  return canonicalIdSchema.parse(`${ref.book}_${ref.chapter}_${ref.verse}`);
}

export function parseCanonicalId(id: string): CanonicalRef {
  const match = CANONICAL_ID_PATTERN.exec(canonicalIdSchema.parse(id));
  if (!match) throw new Error(`canonical_id inválido: ${id}`);
  const [, book, chapter, verse] = match;
  return {
    book: usfmBookSchema.parse(book),
    chapter: Number(chapter),
    verse: Number(verse),
  };
}
