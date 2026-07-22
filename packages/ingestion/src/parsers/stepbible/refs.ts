import type { UsfmBook } from "@bereia/core";
import { tvtmsBookToUsfm } from "../tvtms/books.js";
import {
  tagntWordTypeSchema,
  tahotTextBaseSchema,
  type EditionPresence,
  type TagntWordType,
  type TahotTextType,
} from "./types.js";

/**
 * Parser da coluna 1 (referência) dos TSV do STEPBible, nas duas notações levantadas
 * em docs/plano-stepbible.md §2. Vocabulário fechado: qualquer notação/código fora do
 * documentado EXPLODE com mensagem clara — a ref é contrato externo e o erro aqui
 * contaminaria canonical_id (ADR-002). Códigos de livro reusam a tabela USFM do TVTMS
 * (§3.4: os códigos STEPBible são idênticos aos do TVTMS).
 */

class StepRefParseError extends Error {
  constructor(text: string, detail: string) {
    super(`referência STEPBible inválida "${text}": ${detail}`);
    this.name = "StepRefParseError";
  }
}

/** Par capítulo/verso de uma tradição alternativa (hebraico, NA, etc.). */
export interface VerseRef {
  chapter: number;
  verse: number;
}

/**
 * Referência TAHOT: `Book.Chapter.Verse[(HebCap.HebVerso)]#Pos=TextType`.
 * A ref primária (chapter/verse) já é KJV-alinhada — produz o canonical_id (plano §3.1).
 * `hebrew` traz a numeração hebraica dos parênteses redondos, presente só quando difere;
 * serve ao gate de versificação (N5), não ao canonical_id.
 */
export interface TahotRef {
  source: "tahot";
  /** null → livro deuterocanônico conhecido (pular com estatística). */
  book: UsfmBook | null;
  bookCode: string;
  chapter: number;
  /** 0 = título de Salmo. */
  verse: number;
  hebrew: VerseRef | null;
  position: number;
  textType: TahotTextType;
}

/**
 * Referência TAGNT: `Book.Chapter.Verse[KjvRef](NaRef){Other}#Pos=WordType`.
 * A ref primária (chapter/verse) é NRSV; o KJV vem do colchete reto `[…]` quando difere.
 * O canonical_id sai do KJV (colchete) com fallback à primária — ver `stepCanonicalRef`.
 */
export interface TagntRef {
  source: "tagnt";
  book: UsfmBook | null;
  bookCode: string;
  chapter: number;
  verse: number;
  /** `[…]` = KJV; null ⇒ NRSV == KJV. */
  kjv: VerseRef | null;
  /** `(…)` = Nestlé-Aland. */
  na: VerseRef | null;
  /** `{…}` = outra tradição. */
  other: VerseRef | null;
  position: number;
  wordType: TagntWordType;
}

/** Tipo comum das duas fontes STEPBible. */
export type StepRef = TahotRef | TagntRef;

// TAHOT: livro (até o 1º ponto), cap.verso, (heb) opcional, #pos numérico, =textType.
// #pos: normalmente 2 dígitos, mas 4 dígitos nas palavras reconstruídas/LXX (base X) —
// ex.: Jdg.16.13#2503=X; a semântica do offset é do parser TAHOT (N3), aqui só o inteiro.
const TAHOT_RE =
  /^([^.]+)\.(\d{1,3})\.(\d{1,3})(?:\((\d{1,3})\.(\d{1,3})\))?#(\d+)=(.+)$/;
// TextType: base MAIÚSCULA fechada + marcador parentético cru opcional (Q(K), L(abh), LBH(a+C)).
const TAHOT_TEXTTYPE_RE = /^([A-Z]+)(?:\(([^)]*)\))?$/;

/** Decompõe o campo TextType do TAHOT em base fechada + marcador cru; base desconhecida explode. */
function parseTahotTextType(field: string, source: string): TahotTextType {
  const m = TAHOT_TEXTTYPE_RE.exec(field);
  if (!m) throw new StepRefParseError(source, `TextType malformado "${field}"`);
  const [, base, marker] = m;
  const parsedBase = tahotTextBaseSchema.safeParse(base);
  if (!parsedBase.success) {
    throw new StepRefParseError(source, `base de TextType desconhecida "${base ?? ""}" em "${field}"`);
  }
  return { raw: field, base: parsedBase.data, marker: marker ?? null };
}

// TAGNT: livro.cap.verso na ref primária; o resto (refs alternativas) é o "tail".
const TAGNT_PRIMARY_RE = /^([^.]+)\.(\d{1,3})\.(\d{1,3})(.*)$/;
// Grupos alternativos: [KJV], (NA), {Other} — cada um "cap.verso".
const TAGNT_ALT_RE = /([[({])(\d{1,3})\.(\d{1,3})([\])}])/g;
const ALT_CLOSERS: Readonly<Record<string, string>> = { "[": "]", "(": ")", "{": "}" };

export function parseTahotRef(col1: string): TahotRef {
  const raw = col1.trim();
  const m = TAHOT_RE.exec(raw);
  if (!m) {
    throw new StepRefParseError(raw, "não casa Book.Chapter.Verse[(HebCap.HebVerso)]#Pos=TextType");
  }
  const [, bookCode, chap, verse, hebChap, hebVerse, pos, typeRaw] = m;
  return {
    source: "tahot",
    book: tvtmsBookToUsfm(bookCode as string),
    bookCode: bookCode as string,
    chapter: Number(chap),
    verse: Number(verse),
    hebrew:
      hebChap !== undefined && hebVerse !== undefined
        ? { chapter: Number(hebChap), verse: Number(hebVerse) }
        : null,
    position: Number(pos),
    textType: parseTahotTextType(typeRaw as string, raw),
  };
}

export function parseTagntRef(col1: string): TagntRef {
  const raw = col1.trim();
  const hashIdx = raw.indexOf("#");
  if (hashIdx === -1) throw new StepRefParseError(raw, "falta o marcador '#Pos=WordType'");
  const left = raw.slice(0, hashIdx);
  const right = raw.slice(hashIdx + 1);

  const eqIdx = right.indexOf("=");
  if (eqIdx === -1) throw new StepRefParseError(raw, "falta '=WordType' após a posição");
  const posRaw = right.slice(0, eqIdx);
  const wordTypeRaw = right.slice(eqIdx + 1);
  if (!/^\d+$/.test(posRaw)) throw new StepRefParseError(raw, `posição inválida "${posRaw}"`);

  const pm = TAGNT_PRIMARY_RE.exec(left);
  if (!pm) throw new StepRefParseError(raw, "não casa Book.Chapter.Verse na ref primária");
  const [, bookCode, chap, verse, tail] = pm;

  let kjv: VerseRef | null = null;
  let na: VerseRef | null = null;
  let other: VerseRef | null = null;
  let covered = 0;
  for (const am of (tail as string).matchAll(TAGNT_ALT_RE)) {
    const [full, open, c, v, close] = am;
    if (ALT_CLOSERS[open as string] !== close) {
      throw new StepRefParseError(raw, `delimitadores desbalanceados em "${full}"`);
    }
    const ref: VerseRef = { chapter: Number(c), verse: Number(v) };
    if (open === "[") {
      if (kjv) throw new StepRefParseError(raw, "colchete [KJV] duplicado");
      kjv = ref;
    } else if (open === "(") {
      if (na) throw new StepRefParseError(raw, "parênteses (NA) duplicados");
      na = ref;
    } else {
      if (other) throw new StepRefParseError(raw, "chaves {Other} duplicadas");
      other = ref;
    }
    covered += full.length;
  }
  if (covered !== (tail as string).length) {
    throw new StepRefParseError(raw, `sobra não reconhecida após a ref primária: "${tail as string}"`);
  }

  return {
    source: "tagnt",
    book: tvtmsBookToUsfm(bookCode as string),
    bookCode: bookCode as string,
    chapter: Number(chap),
    verse: Number(verse),
    kjv,
    na,
    other,
    position: Number(posRaw),
    wordType: parseWordType(wordTypeRaw, raw),
  };
}

/**
 * Decompõe o WordType do TAGNT (ex.: "NKO", "N(k)O", "N(K)O", "no", "k", "(k)O") por edição.
 * Cada letra vira presença em dois eixos: minúscula ⇒ variant; entre parênteses ⇒ bracketed.
 * Assim N(K)O e N(k)O ficam distintos (Finding 3). Letra/edição repetida ou desconhecida explode.
 */
function parseWordType(rawType: string, source: string): TagntWordType {
  if (rawType === "") throw new StepRefParseError(source, "WordType vazio");
  let na: EditionPresence | null = null;
  let tr: EditionPresence | null = null;
  let other: EditionPresence | null = null;

  const assign = (letter: string, bracketed: boolean): void => {
    const presence: EditionPresence = { variant: letter !== letter.toUpperCase(), bracketed };
    switch (letter.toLowerCase()) {
      case "n":
        if (na !== null) throw new StepRefParseError(source, `edição N repetida em "${rawType}"`);
        na = presence;
        break;
      case "k":
        if (tr !== null) throw new StepRefParseError(source, `edição K repetida em "${rawType}"`);
        tr = presence;
        break;
      case "o":
        if (other !== null) throw new StepRefParseError(source, `edição O repetida em "${rawType}"`);
        other = presence;
        break;
      default:
        throw new StepRefParseError(source, `letra de edição desconhecida "${letter}" em WordType "${rawType}"`);
    }
  };

  let i = 0;
  while (i < rawType.length) {
    const ch = rawType[i] as string;
    if (ch === "(") {
      const close = rawType.indexOf(")", i);
      if (close === -1) throw new StepRefParseError(source, `parêntese não fechado em WordType "${rawType}"`);
      const inner = rawType.slice(i + 1, close);
      if (inner.length !== 1 || !/[A-Za-z]/.test(inner)) {
        throw new StepRefParseError(source, `parênteses de WordType devem conter 1 letra: "(${inner})"`);
      }
      assign(inner, true);
      i = close + 1;
    } else if (/[A-Za-z]/.test(ch)) {
      assign(ch, false);
      i += 1;
    } else {
      throw new StepRefParseError(source, `caractere inesperado "${ch}" em WordType "${rawType}"`);
    }
  }

  return tagntWordTypeSchema.parse({ raw: rawType, na, tr, other });
}

/**
 * Ref KJV-alinhada que produz o canonical_id, comum às duas fontes (plano §3.1):
 * TAHOT usa a primária (já KJV); TAGNT prefere o colchete `[KJV]` com fallback à primária.
 * Retorna null para livro deuterocanônico (pular).
 */
export function stepCanonicalRef(
  ref: StepRef,
): { book: UsfmBook; chapter: number; verse: number } | null {
  if (ref.book === null) return null;
  if (ref.source === "tahot") {
    return { book: ref.book, chapter: ref.chapter, verse: ref.verse };
  }
  const target = ref.kjv ?? { chapter: ref.chapter, verse: ref.verse };
  return { book: ref.book, chapter: target.chapter, verse: target.verse };
}
