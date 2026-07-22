/**
 * Build de `canonical_verses` + `verse_texts` (N5 do plano de fechamento da
 * Fase 1, §3.3). Funções PURAS: recebem as Bíblias USFX já parseadas e um
 * mapper TVTMS já montado (ADR-002) e devolvem os registros do JSONL canônico
 * — não leem disco nem rede.
 *
 * Decisões ancoradas no plano/OQ:
 * - **Versificação-mestre = KJV (ADR-002).** O conjunto de `canonical_id`
 *   (inventário-mestre) sai EXCLUSIVAMENTE da KJV parseada; BLIVRE/WEB entram
 *   em `verse_texts` passando pelo mapper TVTMS (`toKjv`) — para as três fontes
 *   o mapeamento é quase todo identidade, mas o MECANISMO é o contrato.
 * - **Verso 0 / título de Salmo (OQ-2).** Onde a KJV tem `UsfxChapter.title`,
 *   emite-se a linha estrutural `PSA_x_0` em `canonical_verses` E o texto do
 *   título em `verse_texts` (por tradução que o tenha). Título vira `verse=0`;
 *   `sourceRefSchema` só aceita `verse` positivo, então o título NÃO passa pelo
 *   mapper de corpo — o canonical_id de título é montado direto (identidade de
 *   capítulo, coerente com a numeração inglesa dos Salmos nas três fontes).
 * - **Tradição de versificação (tie-break TVTMS).** As três fontes seguem a
 *   versificação HEBRAICA/massorética do AT (Ester com 10 capítulos, sem as
 *   adições gregas; Salmos, Ml, Jl na divisão inglesa por conteúdo). Passar
 *   `"Hebrew"` como `versificationTradition` é o que o próprio mapper exige
 *   ("resolva a tradição da fonte antes de ingerir") para desempatar Ester
 *   1:1/3:13/4:17/8:12/10:3 — casos que os testes de conteúdo deixam com duas
 *   regras ativas divergentes (Hebrew=mantém verso × GreekUndivided=concatena
 *   as adições Est 11-12, fora do cânon-66). Varredura exaustiva das três
 *   Bíblias confirma que `"Hebrew"` é IDÊNTICO a `"Eng-KJV"` em todo o resto
 *   (Salmos, Ml 4, Jl 3 e o NT permanecem idênticos) — só remove as 5
 *   ambiguidades de Ester, resolvendo-as para a identidade correta.
 * - **Residuais fora do mestre (OQ-4).** Diferenças residuais NT (a doxologia
 *   de Romanos que a WEB numera em 14:24-26 em vez de 16:25-27; um título de
 *   Salmo a mais na WEB) produzem `canonical_id` fora do inventário-mestre.
 *   Política do plano: DESCARTAR com estatística sob teto (`maxDropRate`,
 *   default 0,5%); acima do teto o build FALHA ruidosamente (não é descarte
 *   silencioso, é bug de book-map/versificação).
 * - **Determinismo é requisito de produto (CLAUDE.md §1/§7).** A saída é
 *   ordenada pelos comparadores totais do N4 (`compareCanonicalVerse`,
 *   `compareVerseText`), independente da ordem de iteração dos `Map` de entrada.
 * - **Erros explodem cedo (CLAUDE.md §7).** Colisão de chave
 *   `(canonicalId, translation)` não prevista (merge/split de versificação),
 *   verso em ponte (`verse != verseEnd`, zero no cânon-66 real) ou taxa de
 *   descarte acima do teto EXPLODEM — ambiguidade nova nunca passa silenciosa.
 */

import { makeCanonicalId } from "@bereia/core";
import type { CanonicalId, CanonicalVerse, UsfmBook, VerseText } from "@bereia/core";
import type { UsfxBible, UsfxChapter, UsfxVerse } from "../parsers/usfx/parser.js";
import type { VersificationMapper } from "../parsers/tvtms/contract.js";
import { compareCanonicalVerse, compareVerseText, sortDeterministic } from "./order.js";

/** Um capítulo tem título de Salmo (texto canônico antes do v.1) quando `title` não é vazio. */
function hasTitle(chapter: UsfxChapter): chapter is UsfxChapter & { title: string } {
  return chapter.title !== null && chapter.title !== "";
}

/**
 * Itera os versos ÚNICOS de um capítulo (o `Map.verses` aponta o MESMO objeto
 * para cada número coberto por um verso em ponte; dedupe por identidade de
 * objeto evita processar a ponte duas vezes).
 */
function* uniqueVerses(chapter: UsfxChapter): Generator<UsfxVerse> {
  const seen = new Set<UsfxVerse>();
  for (const verse of chapter.verses.values()) {
    if (seen.has(verse)) continue;
    seen.add(verse);
    yield verse;
  }
}

function makeVerse(book: UsfmBook, chapter: number, verse: number): CanonicalVerse {
  return {
    id: makeCanonicalId({ book, chapter, verse }),
    book,
    chapter,
    verse,
    canonStatus: "protestant",
    theologicalCategory: null,
  };
}

/**
 * Inventário-mestre: todo `canonical_id` do cânon de 66 a partir da KJV
 * parseada (a KJV É a versificação-mestre, ADR-002), incluindo `verse=0` onde
 * a KJV tem título de Salmo (OQ-2). `canonStatus` fixo em `"protestant"` (o
 * enum `deuterocanonical` existe no schema, mas deuterocanônicos estão fora do
 * MVP — CLAUDE.md §2); `theologicalCategory` é `null` (curadoria posterior).
 *
 * Explode em verso em ponte (`verse != verseEnd`): o cânon-66 real não tem
 * nenhum (as pontes da WEB vivem só nos apócrifos, pulados) — se uma fonte
 * futura trouxer, a decisão de split precisa ser tomada conscientemente.
 */
export function buildCanonicalVerses(kjv: UsfxBible): CanonicalVerse[] {
  const out: CanonicalVerse[] = [];
  for (const [book, chapters] of kjv.books) {
    for (const [chapterNum, chapter] of chapters) {
      if (hasTitle(chapter)) {
        out.push(makeVerse(book, chapterNum, 0));
      }
      for (const verse of uniqueVerses(chapter)) {
        if (verse.verse !== verse.verseEnd) {
          throw new Error(
            `buildCanonicalVerses: verso em ponte ${book} ${verse.chapter}:${verse.verse}-${verse.verseEnd} ` +
              "— decisão de split não fixada; cânon-66 não deveria ter pontes",
          );
        }
        out.push(makeVerse(book, verse.chapter, verse.verse));
      }
    }
  }
  return sortDeterministic(out, compareCanonicalVerse);
}

/** Conjunto de `canonical_id` do inventário-mestre — chave de FK de `verse_texts`. */
export function canonicalIdSet(verses: readonly CanonicalVerse[]): ReadonlySet<CanonicalId> {
  return new Set(verses.map((v) => v.id));
}

/** Alvo descartado por cair fora do inventário-mestre (OQ-4) — reportado, nunca silencioso. */
export interface DroppedTarget {
  canonicalId: CanonicalId;
  /** Verso/título da fonte que gerou o alvo (ex.: "ROM 14:24"). */
  origin: string;
}

export interface VerseTextsStats {
  translation: string;
  /** Alvos `canonical_id` tentados (corpos mapeados + títulos), antes do descarte. */
  attemptedTargets: number;
  emitted: number;
  dropped: DroppedTarget[];
  /** `dropped.length / attemptedTargets`. */
  dropRate: number;
}

export interface VerseTextsResult {
  verseTexts: VerseText[];
  stats: VerseTextsStats;
}

export interface VerseTextsBuildInput {
  /** Bíblia da tradução parseada (KJV, WEB ou BLIVRE). */
  source: UsfxBible;
  /** Rótulo da tradução gravado em `verse_texts.translation` (ex.: "KJV"). */
  translation: string;
  /** Tradição de versificação da fonte, insumo do desempate TVTMS (ver nota de topo: "Hebrew"). */
  versificationTradition: string;
  /** Mapper TVTMS já montado com o `SourceInventory` desta fonte e o `StandardInventory` da KJV. */
  mapper: VersificationMapper;
  /** Inventário-mestre (saída de `buildCanonicalVerses`) para checagem de FK. */
  inventory: ReadonlySet<CanonicalId>;
  /** Teto de taxa de descarte de alvos fora do mestre (OQ-4). Default 0,5%. */
  maxDropRate?: number;
}

const DEFAULT_MAX_DROP_RATE = 0.005;

/**
 * Constrói as linhas de `verse_texts` de UMA tradução: cada verso de corpo
 * passa pelo mapper TVTMS (`toKjv`), cada título de Salmo vira uma linha
 * `verse=0` (OQ-2). Metadados no default do plano §3.3 (`embeddingModel:null`,
 * `thematicTags:[]`, `culturalContext:null`, `humanReviewed:false`,
 * `reviewedBy:null`, `authorizedLevels:["public"]`). Saída ordenada
 * (`compareVerseText`).
 *
 * Invariantes:
 * - **FK garantida por construção:** todo `verse_text` EMITIDO tem
 *   `canonicalId ∈ inventory`. Alvo fora do mestre é DESCARTADO e contabilizado
 *   em `stats.dropped` (OQ-4), não emitido — a suíte checa `stats` e a FK.
 * - **Teto de descarte:** `dropRate > maxDropRate` EXPLODE (OQ-4: falha ruidosa
 *   — indica book-map/versificação quebrada, não residual esperado).
 * - **Unicidade `(canonicalId, translation)`:** duas origens colidindo na mesma
 *   chave (merge/split de versificação) EXPLODEM (ambiguidade nova, não fixada).
 */
export function buildVerseTexts(input: VerseTextsBuildInput): VerseTextsResult {
  const { source, translation, versificationTradition, mapper, inventory } = input;
  const maxDropRate = input.maxDropRate ?? DEFAULT_MAX_DROP_RATE;

  const verseTexts: VerseText[] = [];
  const dropped: DroppedTarget[] = [];
  const seenKeys = new Set<CanonicalId>();
  let attemptedTargets = 0;

  const emit = (canonicalId: CanonicalId, text: string, origin: string): void => {
    attemptedTargets++;
    if (!inventory.has(canonicalId)) {
      // Residual fora do cânon-mestre (OQ-4): descarta com estatística.
      dropped.push({ canonicalId, origin });
      return;
    }
    if (seenKeys.has(canonicalId)) {
      throw new Error(
        `buildVerseTexts[${translation}]: chave (${canonicalId}, ${translation}) duplicada a partir de ${origin} ` +
          "— colisão de versificação (merge/split) não prevista; ambiguidade nova explode",
      );
    }
    seenKeys.add(canonicalId);
    verseTexts.push({
      canonicalId,
      translation,
      text,
      embeddingModel: null,
      thematicTags: [],
      culturalContext: null,
      humanReviewed: false,
      reviewedBy: null,
      authorizedLevels: ["public"],
    });
  };

  for (const [book, chapters] of source.books) {
    for (const [chapterNum, chapter] of chapters) {
      if (hasTitle(chapter)) {
        // Título = verso 0; não passa pelo mapper de corpo (sourceRef exige
        // verse>0). Capítulo é identidade na numeração inglesa dos Salmos.
        emit(
          makeCanonicalId({ book, chapter: chapterNum, verse: 0 }),
          chapter.title,
          `título ${book} ${chapterNum}`,
        );
      }
      for (const verse of uniqueVerses(chapter)) {
        if (verse.text === "") continue; // marcador sem conteúdo (ex.: At 8:37 na WEB)
        if (verse.verse !== verse.verseEnd) {
          throw new Error(
            `buildVerseTexts[${translation}]: verso em ponte ${book} ${verse.chapter}:${verse.verse}-${verse.verseEnd} ` +
              "— decisão de split não fixada",
          );
        }
        const mapped = mapper.toKjv({
          book,
          chapter: chapterNum,
          verse: verse.verse,
          tradition: versificationTradition,
        });
        if (mapped.length === 0) {
          throw new Error(
            `buildVerseTexts[${translation}]: ${book} ${chapterNum}:${verse.verse} mapeou para 0 versos KJV ` +
              "— verso da fonte sem destino no mestre não é descartado silenciosamente",
          );
        }
        for (const ref of mapped) {
          emit(
            makeCanonicalId({ book: ref.book, chapter: ref.chapter, verse: ref.verse }),
            verse.text,
            `${book} ${chapterNum}:${verse.verse}`,
          );
        }
      }
    }
  }

  const dropRate = attemptedTargets === 0 ? 0 : dropped.length / attemptedTargets;
  if (dropRate > maxDropRate) {
    const sample = dropped.slice(0, 10).map((d) => `${d.origin}→${d.canonicalId}`).join(", ");
    throw new Error(
      `buildVerseTexts[${translation}]: taxa de descarte ${(dropRate * 100).toFixed(3)}% acima do teto ` +
        `${(maxDropRate * 100).toFixed(3)}% (${dropped.length}/${attemptedTargets}) — provável book-map/versificação ` +
        `quebrada, não residual esperado. Amostra: ${sample}`,
    );
  }

  return {
    verseTexts: sortDeterministic(verseTexts, compareVerseText),
    stats: { translation, attemptedTargets, emitted: verseTexts.length, dropped, dropRate },
  };
}
