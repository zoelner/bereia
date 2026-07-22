import { isCanonicalTvtmsBook, NON_CANONICAL_TVTMS_BOOKS } from "./books.js";

/**
 * Referências no vocabulário do TVTMS (seção Expanded).
 *
 * Gramática observada no dado real (ver docs/spike-tvtms.md):
 *   lista    := segmento (';' segmento)*
 *   segmento := [Livro '.'] [Capítulo ':'] item (',' item)*
 *   item     := token ['-' fim]
 *   token    := (número | 'Title') [letras] ['!' subverso] ['.' índice]
 *   fim      := [Capítulo ':'] token | letras        // "2:25-3:1" | "1-3" | "37a-c"
 * Livro e capítulo são herdados do contexto quando omitidos ("33:31", "21-22").
 * Capítulos-letra (Est.A) só ocorrem em livros deuterocanônicos.
 */
export interface TvtmsRef {
  /** Código TVTMS ("Psa"); pode ser não-canônico em refs de Tests. */
  book: string;
  /** Número, ou letra ("A".."F") nos acréscimos deuterocanônicos de Ester. */
  chapter: number | string;
  verse: number | "Title";
  /** Parte de verso: "a", "b1", "0" (de "!a"), "2" (de ".2"), "c" (de "37c"). */
  subverse: string | null;
}

export type RefItem =
  | { kind: "single"; ref: TvtmsRef }
  | { kind: "range"; start: TvtmsRef; end: TvtmsRef }
  /** Fallback leniente: só admitido para livros fora do cânon de 66. */
  | { kind: "raw"; text: string };

const BOOK_RE = /^([0-9]?[A-Z][A-Za-z0-9]{1,3})\.(?=[0-9A-F]|Title)/;
const CHAPTER_RE = /^([0-9]+|[A-F]):/;
// Subverso em quatro notações: "37a" (colada), "35*a" (extras LXX), "1!a", "1.2".
const TOKEN_RE = /^([0-9]+|Title)(?:\*?([a-z]+[0-9]?))?(?:!([a-z0-9]+))?(?:\.([0-9]+))?$/;

class RefParseError extends Error {
  constructor(text: string, detail: string) {
    super(`referência TVTMS inválida "${text}": ${detail}`);
    this.name = "RefParseError";
  }
}

function parseToken(
  raw: string,
  book: string,
  chapter: number | string,
  source: string,
): TvtmsRef {
  const m = TOKEN_RE.exec(raw);
  if (!m) throw new RefParseError(source, `token de verso "${raw}" não reconhecido`);
  const [, verseRaw, attached, bang, dotIndex] = m;
  const parts = [attached, bang, dotIndex].filter((p): p is string => p !== undefined);
  if (parts.length > 1) {
    throw new RefParseError(source, `token "${raw}" combina mais de uma notação de subverso`);
  }
  return {
    book,
    chapter,
    verse: verseRaw === "Title" ? "Title" : Number(verseRaw),
    subverse: parts[0] ?? null,
  };
}

function parseChapter(raw: string): number | string {
  return /^[0-9]+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Parseia uma lista de referências (colunas SourceRef/StandardRef).
 * Livros fora do cânon: itens inparseáveis viram {kind:"raw"} (dado
 * deuterocanônico com typos no upstream); no cânon de 66, qualquer
 * desvio de gramática explode — erro aqui contaminaria canonical_id.
 */
export function parseRefList(text: string, contextBook?: string): RefItem[] {
  const items: RefItem[] = [];
  let book = contextBook ?? null;
  let chapter: number | string | null = null;

  for (const segmentRaw of text.split(";")) {
    const segment = segmentRaw.trim();
    if (segment === "") continue;
    let rest = segment;

    const bookMatch = BOOK_RE.exec(rest);
    if (bookMatch) {
      book = bookMatch[1] as string;
      rest = rest.slice(bookMatch[0].length);
      chapter = null;
    }
    const chapterMatch = CHAPTER_RE.exec(rest);
    if (chapterMatch) {
      chapter = parseChapter(chapterMatch[1] as string);
      rest = rest.slice(chapterMatch[0].length);
    }
    if (book === null || chapter === null) {
      throw new RefParseError(text, `segmento "${segment}" sem livro/capítulo resolvível`);
    }

    for (const itemRaw of rest.split(",")) {
      const item = itemRaw.trim();
      if (item === "") continue;
      try {
        items.push(parseItem(item, book, chapter, text));
      } catch (err) {
        if (err instanceof RefParseError && !isCanonicalTvtmsBook(book)) {
          items.push({ kind: "raw", text: `${book}.${String(chapter)}:${item}` });
          continue;
        }
        throw err;
      }
    }
  }
  if (items.length === 0) throw new RefParseError(text, "lista vazia");
  return items;
}

function parseItem(
  item: string,
  book: string,
  chapter: number | string,
  source: string,
): RefItem {
  // "Title" não participa de ranges; o hífen só é separador entre tokens de verso.
  const dash = item.indexOf("-");
  if (dash === -1 || item.startsWith("Title")) {
    return { kind: "single", ref: parseToken(item, book, chapter, source) };
  }

  const startRaw = item.slice(0, dash);
  const endRaw = item.slice(dash + 1);
  const start = parseToken(startRaw, book, chapter, source);

  // Fim pode trocar de capítulo ("2:25-3:1"), ser só letras ("37a-c") ou verso simples.
  const endChapterMatch = CHAPTER_RE.exec(endRaw);
  if (endChapterMatch) {
    const endChapter = parseChapter(endChapterMatch[1] as string);
    const end = parseToken(endRaw.slice(endChapterMatch[0].length), book, endChapter, source);
    return { kind: "range", start, end };
  }
  if (/^[a-z]+[0-9]?$/.test(endRaw)) {
    return {
      kind: "range",
      start,
      end: { book, chapter, verse: start.verse, subverse: endRaw },
    };
  }
  return { kind: "range", start, end: parseToken(endRaw, book, chapter, source) };
}

/** Parseia uma referência única (refs dentro de Tests). Nunca lista/range. */
export function parseSingleRef(text: string, contextBook?: string): TvtmsRef {
  const items = parseRefList(text.trim(), contextBook);
  const [first] = items;
  if (items.length !== 1 || first === undefined || first.kind !== "single") {
    throw new RefParseError(text, "esperada referência única");
  }
  return first.ref;
}

/** True quando o livro do item pertence ao cânon de 66 (raw nunca pertence). */
export function refItemIsCanonical(item: RefItem): boolean {
  if (item.kind === "raw") return false;
  const book = item.kind === "single" ? item.ref.book : item.start.book;
  return isCanonicalTvtmsBook(book) && !NON_CANONICAL_TVTMS_BOOKS.has(book);
}
