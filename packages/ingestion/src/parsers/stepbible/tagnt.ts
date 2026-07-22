import { makeCanonicalId, type UsfmBook } from "@bereia/core";
import { normalizeStrong } from "./strongs.js";
import { parseTagntRef, stepCanonicalRef } from "./refs.js";
import { taggedWordRowSchema, type TaggedWordRow } from "./types.js";

/**
 * Parser do TAGNT (NT grego amalgamado do STEPBible, CC BY 4.0), lendo os 2 arquivos
 * reais (`TAGNT_Mat-Jhn.txt`, `TAGNT_Act-Rev.txt`) pinados no manifest. Cada LINHA DE
 * PALAVRA vira uma TaggedWordRow (plano-stepbible.md §3.3), com o canonical_id KJV vindo
 * do colchete reto `[KJV]` (via stepCanonicalRef/N1) e o carimbo de edição por palavra
 * (WordType) preservado cru — a projeção TR/NA filtra depois (Q4: carregar TUDO carimbado).
 *
 * Vocabulário fechado, determinismo é requisito de produto: uma linha COM assinatura de
 * palavra (`#Pos=` na col 1) que não parseie EXPLODE com o número da linha. Linhas sem essa
 * assinatura (cabeçalho de licença, sumário `#_…`, vazias) são puladas e contadas.
 */

/** Estatística de varredura — cabeçalhos/sumários pulados, nunca silenciados. */
export interface TagntParseStats {
  /** Linhas de palavra emitidas (uma TaggedWordRow cada). */
  words: number;
  /** Linhas puladas por não terem assinatura de palavra (`#Pos=` na col 1). */
  skippedNonWord: number;
}

export interface TagntParseResult {
  rows: TaggedWordRow[];
  stats: TagntParseStats;
}

class TagntParseError extends Error {
  constructor(line: number, detail: string) {
    super(`TAGNT linha ${line}: ${detail}`);
    this.name = "TagntParseError";
  }
}

/** Assinatura mínima de uma linha de palavra na col 1: `…#<pos>=…` (vs. sumário `#_…`). */
const WORD_LINE_COL1 = /#\d+=/;

/**
 * Número Strong estendido do STEPBible (≥ 5 dígitos, ex.: G20447, G20833): supera o dict
 * openscriptures de 4 dígitos (`/^[HG]\d{1,4}$/`) e NÃO tem entrada canônica — não é lixo,
 * é uma categoria reconhecida. `strong_id` fica null; o dStrong íntegro vai em `strong_raw`.
 * (3 ocorrências reais: Act.24.12 e 2Co.11.28 = G20447; 1Th.2.8 = G20833.)
 *
 * Restrito à letra grega (`G`): este arquivo só resolve dStrong em contexto "greek"
 * (`resolveStrong` sempre chama `normalizeStrong(dStrong, "greek")`), então um código de
 * 5+ dígitos com prefixo `H` seria idioma errado — deve explodir como qualquer dStrong
 * fora do vocabulário, não ser absorvido silenciosamente aqui como "estendido".
 */
const EXTENDED_STRONG = /^G\d{5,}[A-Z]?$/;

/**
 * Resolve o `strong_id` canônico (e o dStrong bruto) de um campo dStrong=Grammar (col 4).
 * - dStrong = tudo antes do 1º `=`; morphology = o resto (grammar), null se vazio.
 * - Estendido (≥5 díg.) → strongId null (categoria reconhecida, sem entrada no dict de 4 díg.).
 * - Caso contrário delega a N2 (`normalizeStrong`): 4 díg. + letra de desambiguação →
 *   radical de 4 díg.; tag gramatical G9xxx → null; QUALQUER outra coisa EXPLODE (N2).
 */
function resolveStrong(col4: string, line: number): {
  strongId: string | null;
  strongRaw: string | null;
  morphology: string | null;
} {
  const eq = col4.indexOf("=");
  if (eq === -1) {
    throw new TagntParseError(line, `coluna dStrong=Grammar sem '=': "${col4}"`);
  }
  const dStrong = col4.slice(0, eq);
  const grammar = col4.slice(eq + 1);
  if (dStrong.length === 0) {
    throw new TagntParseError(line, `dStrong vazio em "${col4}"`);
  }

  const strongRaw = dStrong;
  const morphology = grammar.length > 0 ? grammar : null;

  if (EXTENDED_STRONG.test(dStrong)) {
    return { strongId: null, strongRaw, morphology };
  }
  try {
    return { strongId: normalizeStrong(dStrong, "greek"), strongRaw, morphology };
  } catch (err) {
    throw new TagntParseError(line, (err as Error).message);
  }
}

/** Parseia o TSV de um arquivo TAGNT inteiro; devolve as palavras + estatística de varredura. */
export function parseTagntFile(tsv: string): TagntParseResult {
  const lines = tsv.split("\n");
  const rows: TaggedWordRow[] = [];
  let skippedNonWord = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, "");
    const tab = raw.indexOf("\t");
    const col1 = tab === -1 ? raw : raw.slice(0, tab);

    // Só linhas com assinatura de palavra (`#Pos=`) são de palavra; o resto é
    // cabeçalho/sumário/vazio — pulado e contado (nunca silenciado).
    if (!WORD_LINE_COL1.test(col1)) {
      skippedNonWord++;
      continue;
    }

    const lineNo = i + 1;
    const cells = raw.split("\t");
    const lexeme = (cells[1] ?? "").trim();
    const col4 = (cells[3] ?? "").trim();
    if (lexeme.length === 0) {
      throw new TagntParseError(lineNo, "texto grego (col 2) vazio");
    }
    if (col4.length === 0) {
      throw new TagntParseError(lineNo, "coluna dStrong=Grammar (col 4) vazia");
    }

    let canonical: { book: UsfmBook; chapter: number; verse: number } | null;
    let editionRaw: string;
    let position: number;
    try {
      const ref = parseTagntRef(col1);
      canonical = stepCanonicalRef(ref);
      editionRaw = ref.wordType.raw;
      position = ref.position;
    } catch (err) {
      throw new TagntParseError(lineNo, (err as Error).message);
    }

    // NT não tem deuterocanônico; se aparecesse, stepCanonicalRef devolveria null.
    if (canonical === null) {
      skippedNonWord++;
      continue;
    }

    const { strongId, strongRaw, morphology } = resolveStrong(col4, lineNo);

    const row = taggedWordRowSchema.parse({
      canonicalId: makeCanonicalId(canonical),
      position,
      lexeme,
      strongId,
      strongRaw,
      morphology,
      edition: editionRaw,
    });
    rows.push(row);
  }

  return { rows, stats: { words: rows.length, skippedNonWord } };
}

/**
 * Port público (plano §3.3): assinatura preservada do stub original — `parseTagnt(tsv) →
 * TaggedWordRow[]`. Descarta a estatística; use `parseTagntFile` quando precisar dela.
 */
export function parseTagnt(tsv: string): TaggedWordRow[] {
  return parseTagntFile(tsv).rows;
}

/**
 * Projeção Textus Receptus (plano §2.3): uma palavra pertence ao TR ⇔ o WordType contém a
 * letra K/k (K = Scrivener 1894 = TR; minúscula = variante, mas ainda TR). Opera sobre o
 * `edition` cru da TaggedWordRow — o vocabulário de letras é fechado a N/K/O por N1, então a
 * presença de K/k é decisão suficiente e determinística.
 */
export function editionIncludesTr(edition: string): boolean {
  return /[Kk]/.test(edition);
}

/** Projeção Nestlé-Aland: palavra ∈ NA ⇔ WordType contém a letra N/n. */
export function editionIncludesNa(edition: string): boolean {
  return /[Nn]/.test(edition);
}
