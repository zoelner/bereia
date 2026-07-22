/**
 * Build de `original_words` (N6, plano de fechamento da Fase 1 §4): junta os
 * parsers STEPBible prontos (`parseTahot`/`parseTagnt` — LIGAR, não
 * reimplementar) num único conjunto de `OriginalWord` do core, pronto para o
 * JSONL canônico (`data/canonical/original_words/{BOOK}.jsonl`).
 *
 * Cada `TaggedWordRow` (contrato de saída dos parsers) já traz os campos de uma
 * palavra ortográfica original alinhada ao `canonical_id` mestre (KJV) — o
 * mapeamento para `OriginalWord` é campo-a-campo, revalidado pelo schema Zod do
 * core (fronteira, CLAUDE.md §7). Este nó acrescenta apenas as garantias de
 * conjunto COMBINADO (AT+NT) que nenhum parser isolado pode dar:
 *
 * - **Chave primária (canonicalId, position) única** no conjunto inteiro — é a
 *   PK de `original_words` (CLAUDE.md §5). AT (TAHOT) e NT (TAGNT) não colidem
 *   por livro, mas a invariante é ASSERTADA (explode cedo), nunca presumida:
 *   qualquer colisão é bug de determinismo/PK, não passa silenciosa.
 * - **Forma canônica do `strongId`** (`/^[HG]\d{4}$/`, zero-padded — OQ-6-b):
 *   é o contrato de FK com `strongs.id` (N1). Todo `strongId` não-nulo é
 *   verificado; forma fora do padrão explode. A EXISTÊNCIA de fato no
 *   dicionário é FK de dado (verificada na integração de `words.test.ts`
 *   contra o `strongs.jsonl` real), não estrutural.
 * - **Ordem determinística** via os comparadores do N4 (`compareOriginalWord`):
 *   livro (ordem do cânon) → capítulo → verso → `position`. Mesma entrada, em
 *   qualquer ordem → mesma saída byte a byte (requisito de produto).
 *
 * O carimbo `edition` (coluna nullable adicionada por N0/OQ-6) segue o que o
 * parser produz: TextType cru no TAHOT (base Leningrad = `"L"`, Qere/variantes
 * carimbados) e WordType cru no TAGNT (`"NKO"`, `"K"`, …) — preserva o filtro
 * TR (`K ∈ wordType`) sem perda. Este nó NÃO reinterpreta o carimbo.
 */

import { originalWordSchema, parseCanonicalId, type OriginalWord, type UsfmBook } from "@bereia/core";
import { parseTahot, parseTagnt, type TaggedWordRow } from "../parsers/stepbible/index.js";
import { compareOriginalWord, sortDeterministic } from "./order.js";

/**
 * Forma canônica do `strong_id` (OQ-6-b): letra de série + 4 dígitos
 * zero-padded. É a mesma forma que o dicionário Strong (N1) emite para o `id`
 * (`H0001`…`H8674`, `G0001`…`G5624`), logo o casamento estrutural aqui é
 * pré-condição do JOIN `original_words.strong_id → strongs.id`.
 */
export const CANONICAL_STRONG_ID_RE = /^[HG]\d{4}$/;

/**
 * Maior número Strong grego coberto pelo dicionário openscriptures (N1, plano
 * §2.1: 5624 entradas `G0001`…`G5624`). O STEPBible referencia, ALÉM desse
 * intervalo, léxicos ESTENDIDOS próprios no espaço `G6xxx`/`G7xxx` (6000–7530
 * no dado real pinado) — mesma natureza dos estendidos de 5 dígitos da OQ-7
 * (`G20447`…), só que empacotados em 4 dígitos e por isso NÃO capturados pela
 * regra `EXTENDED_STRONG` (≥5 díg.) do `parseTagnt`. Sem entrada no dicionário,
 * são FK-órfãos: `isExtendedGreekStrongId` os identifica para a checagem de FK
 * da integração distinguir "estendido conhecido" de "órfão inesperado".
 */
export const GREEK_OPENSCRIPTURES_MAX = 5624;

/**
 * Verdadeiro para um `strongId` grego ALÉM do dicionário openscriptures
 * (número > `GREEK_OPENSCRIPTURES_MAX`) — categoria de léxico STEPBible
 * estendido sem entrada em `strongs.jsonl` (ver `GREEK_OPENSCRIPTURES_MAX`).
 * Assume forma canônica `/^[HG]\d{4}$/` (garantida por `taggedWordToOriginalWord`).
 */
export function isExtendedGreekStrongId(strongId: string): boolean {
  const match = CANONICAL_STRONG_ID_RE.exec(strongId);
  if (match === null || strongId[0] !== "G") return false;
  return Number(strongId.slice(1)) > GREEK_OPENSCRIPTURES_MAX;
}

/**
 * Mapeia uma `TaggedWordRow` (parser STEPBible) para um `OriginalWord` do core,
 * revalidando pela fronteira Zod. Explode se o `strongId` não-nulo fugir da
 * forma canônica `/^[HG]\d{4}$/` (OQ-6-b) — o contrato de FK com `strongs.id`
 * é estrutural e não pode degradar em silêncio (ADR-008).
 */
export function taggedWordToOriginalWord(row: TaggedWordRow): OriginalWord {
  if (row.strongId !== null && !CANONICAL_STRONG_ID_RE.test(row.strongId)) {
    throw new Error(
      `original_words ${row.canonicalId}#${String(row.position)}: strongId "${row.strongId}" ` +
        `fora da forma canônica /^[HG]\\d{4}$/ (quebra a FK com strongs.id)`,
    );
  }
  return originalWordSchema.parse({
    canonicalId: row.canonicalId,
    position: row.position,
    lexeme: row.lexeme,
    strongId: row.strongId,
    strongRaw: row.strongRaw,
    morphology: row.morphology,
    edition: row.edition,
  });
}

/**
 * Assere que `(canonicalId, position)` é único no conjunto — é a PK de
 * `original_words` (CLAUDE.md §5). Explode com a chave colidente e ambas as
 * posições no arquivo de origem lógico. Chamado por `assembleOriginalWords`.
 */
function assertUniquePositions(words: readonly OriginalWord[]): void {
  const seen = new Set<string>();
  for (const word of words) {
    const key = `${word.canonicalId}#${String(word.position)}`;
    if (seen.has(key)) {
      throw new Error(
        `original_words: chave (canonicalId, position) duplicada "${key}" no conjunto combinado ` +
          `— viola a PK de original_words`,
      );
    }
    seen.add(key);
  }
}

/**
 * Monta o conjunto final de `OriginalWord` a partir das `TaggedWordRow` já
 * parseadas (AT+NT): mapeia campo-a-campo (revalidando), assere a PK
 * `(canonicalId, position)` única e ordena de forma determinística
 * (`compareOriginalWord`, N4). Não muta a entrada. Separado de
 * `buildOriginalWords` para permitir teste unitário com linhas sintéticas
 * (mock) sem depender das fontes reais.
 */
export function assembleOriginalWords(rows: readonly TaggedWordRow[]): OriginalWord[] {
  const words = rows.map(taggedWordToOriginalWord);
  assertUniquePositions(words);
  return sortDeterministic(words, compareOriginalWord);
}

/** Conteúdo TSV das fontes STEPBible (as duas séries, na ordem dos arquivos pinados). */
export interface StepbibleWordSources {
  /** TSV dos 4 arquivos TAHOT (AT hebraico amalgamado). */
  tahot: readonly string[];
  /** TSV dos 2 arquivos TAGNT (NT grego amalgamado). */
  tagnt: readonly string[];
}

/**
 * Build completo de `original_words` (N6): parseia cada fonte STEPBible com os
 * ports prontos (`parseTahot`/`parseTagnt`), concatena AT+NT e delega a
 * `assembleOriginalWords` (PK única + ordem determinística). Retorno pronto
 * para `writeOriginalWords` (N4) → `data/canonical/original_words/`.
 */
export function buildOriginalWords(sources: StepbibleWordSources): OriginalWord[] {
  const rows: TaggedWordRow[] = [];
  for (const tsv of sources.tahot) rows.push(...parseTahot(tsv));
  for (const tsv of sources.tagnt) rows.push(...parseTagnt(tsv));
  return assembleOriginalWords(rows);
}

/**
 * Conjunto de `strongId` não-nulos referenciados por `words` — insumo do
 * cross-check de FK contra `strongs.jsonl` (N1) na integração. Determinístico
 * (a semântica é conjunto; a ordem de iteração não é assertada).
 */
export function referencedStrongIds(words: readonly OriginalWord[]): Set<string> {
  const ids = new Set<string>();
  for (const word of words) {
    if (word.strongId !== null) ids.add(word.strongId);
  }
  return ids;
}

/** Livro USFM de um `OriginalWord` (via `parseCanonicalId` do core). */
export function wordBook(word: OriginalWord): UsfmBook {
  return parseCanonicalId(word.canonicalId).book;
}
