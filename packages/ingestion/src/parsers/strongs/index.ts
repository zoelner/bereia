/**
 * Parser dos dicionários Strong (openscriptures/strongs, Domínio Público).
 *
 * Duas fontes HETEROGÊNEAS convergindo no MESMO `strongsEntrySchema` do core
 * (`{id, language, lemma, transliteration, definition}`), ver docs/plano-fechamento-fase1.md §2.1/§3.1:
 *
 * - Hebraico `StrongHebrewG.xml` (OSIS): `<div type="entry"><w ID="H1" .../> …</div>`.
 * - Grego `strongsgreek.xml` (DTD próprio): `<entry strongs="00001"><strongs>1</strongs> …</entry>`.
 *
 * Cada leitor vive no seu módulo (`hebrew.ts`, `greek.ts`); este barrel expõe os dois,
 * o combinador `parseStrongsDict` e o normalizador de id COMPARTILHADO — a peça que garante
 * o contrato de FK com `original_words.strongId` do STEPBible.
 *
 * ## Forma canônica do id (invariante entre nós — plano §2.1/OQ-6-b)
 * O STEPBible produz `strongId` 4-dígitos zero-padded (`SEGMENT_RE = /^([HG])(\d{4})([A-Z]?)$/`
 * em `stepbible/strongs.ts` → `H7225`, `G0976`). Logo o dicionário DEVE emitir o `id` na MESMA
 * forma `/^[HG]\d{4}$/` (`H0001`, `G0001`, `H8674`, `G5624`) — nunca `H1`/`00001` cru. Os máximos
 * reais (8674 H / 5624 G) cabem em 4 dígitos. `toCanonicalStrongId` é o único ponto que impõe
 * isso; um número fora de 1..9999 EXPLODE (vocabulário fechado, ADR-008).
 */

import { parseStrongsHebrew } from "./hebrew.js";
import { parseStrongsGreek } from "./greek.js";
import type { StrongsEntry } from "@bereia/core";

export { parseStrongsHebrew } from "./hebrew.js";
export { parseStrongsGreek } from "./greek.js";

/** Erro de fronteira do parser Strong: explode cedo, mensagem clara (CLAUDE.md §7). */
export class StrongsParseError extends Error {
  constructor(message: string) {
    super(`dicionário Strong inválido: ${message}`);
    this.name = "StrongsParseError";
  }
}

const DIGITS_RE = /^\d+$/;

/**
 * Normaliza um número Strong bruto (`"1"`, `"00001"`, `"8674"`) para a forma canônica
 * `/^[HG]\d{4}$/` esperada por `original_words.strongId` (STEPBible, plano §2.1/OQ-6-b).
 * `letter` é o prefixo de série ("H" hebraico | "G" grego). Explode se `digits` não for
 * inteiro representável em 4 dígitos (fora de 1..9999) — vocabulário fechado.
 */
export function toCanonicalStrongId(letter: "H" | "G", digits: string): string {
  if (!DIGITS_RE.test(digits)) {
    throw new StrongsParseError(`número Strong "${digits}" não é uma sequência de dígitos`);
  }
  const n = Number(digits);
  if (n < 1) {
    throw new StrongsParseError(`número Strong "${digits}" deve ser >= 1`);
  }
  if (n > 9999) {
    throw new StrongsParseError(
      `número Strong ${n} excede 4 dígitos — quebra a forma canônica /^[HG]\\d{4}$/`,
    );
  }
  return `${letter}${String(n).padStart(4, "0")}`;
}

export interface StrongsDictInput {
  /** Conteúdo de `data/sources/strongs/StrongHebrewG.xml` (OSIS). */
  hebrewXml: string;
  /** Conteúdo de `data/sources/strongs/strongsgreek.xml` (DTD próprio). */
  greekXml: string;
}

/**
 * Parseia os dois dicionários e concatena (hebraico primeiro, grego depois). A ORDEM de
 * gravação canônica é responsabilidade do nó de load (ordena por `(language, id)`); aqui
 * a saída apenas preserva a ordem do documento dentro de cada série.
 */
export function parseStrongsDict(input: StrongsDictInput): StrongsEntry[] {
  return [...parseStrongsHebrew(input.hebrewXml), ...parseStrongsGreek(input.greekXml)];
}
