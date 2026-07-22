import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { makeCanonicalId } from "@bereia/core";
import { aggregateHebrewVerses, type HebrewVerseAggregate } from "./tahot.js";
import { parseTahotRef, stepCanonicalRef } from "./refs.js";
import { parseTvtmsExpanded } from "../tvtms/expanded.js";
import { TvtmsMapper } from "../tvtms/mapper.js";
import { TVTMS_TO_USFM } from "../tvtms/books.js";
import type { SourceInventory } from "../tvtms/tests-grammar.js";
import { parseUsfx } from "../usfx/parser.js";
import { usfxStandardInventory } from "../usfx/inventory.js";

/**
 * GATE DE VERSIFICAÇÃO — cross-check TVTMS × ref KJV embutida do TAHOT (N5, ADR-002).
 *
 * Fecha a decisão Q1 (docs/plano-stepbible.md): o `canonical_id` do TAHOT é produzido
 * pela ref KJV que o STEPBible já embute (col 1); o NOSSO mapper TVTMS (`toKjv`,
 * golden 100% verde) roda aqui como VERIFICAÇÃO INDEPENDENTE. É o primeiro exercício
 * REAL dos Renumber hebraicos (títulos de Salmos, Malaquias, Joel) contra contagens de
 * palavras REAIS — antes só a simulação (`golden.test.ts`) cobria isso.
 *
 * Semântica de tradição FIXADA (decisão consciente exigida pela tarefa):
 *   Na tradição hebraica o TÍTULO de Salmo É o v.1 — um verso numerado de verdade, não
 *   um "texto antes do v.1". O agregado (`aggregateHebrewVerses`) já reflete isso: as
 *   palavras do título (KJV v.0) caem na ref HEBRAICA `Psa.N:1` com `isTitle=true`.
 *   Consequência para os predicados dos Tests, vistos como uma Bíblia hebraica os veria:
 *     - `Psa.N:TextBeforeV1` → NotExist (não há verso 0; o título ocupa o v.1);
 *     - `Psa.N:Title=Exist`  → false   (não há "Title" separado — ele é o v.1);
 *     - `=Last` e contagens   → sobre a numeração hebraica (título empurra tudo +1).
 *   É exatamente o inventário `{ title: false, last: N+1 }` que o golden usa para a
 *   tradição hebraica dos Salmos.
 *
 * VEREDICTO — CONCORDÂNCIA MÓDULO GRANULARIDADE (o gate NÃO exige 100%).
 * A comparação é CONJUNTO → CONJUNTO (o mapper devolve 0..n refs em splits/merges; verso 0
 * = título) — nunca colapsada à força para 1:1. Onde os dois lados divergem, o desvio é
 * ACEITO desde que caia EXATAMENTE no conjunto conhecido, congelado em `KNOWN_DIVERGENCES`.
 * Sem os arquivos (CI), a suíte é PULADA — nunca verde falso (ADR-006/ADR-008).
 *
 * DECISÃO DO DONO (2026-07-22 — Opção A APROVADA): aceitar a categoria. A ref embutida é
 * CANÔNICA (produtora do canonical_id, Q1); onde o mapper TVTMS (verso a verso) não reproduz
 * o split que a ref embutida faz por PALAVRA, a ref embutida vence e o desvio é aceito.
 * 23.213 versos hebraicos varridos; 23.155 concordam EXATO; 58 são vazamento verso×palavra:
 *   - 53 TÍTULO-MESCLADO (TM): heb v.1 = KJV {v.0 título, v.1 corpo}. A premissa do plano
 *     ("todo título desloca +1 como o Sl 3") é FALSA — 53 Salmos MESCLAM o título no v.1.
 *     Regra TVTMS `EngTitleMerged+Hebrew | Keep verse` (Sl 133: identidade). O Expanded não
 *     roteia verso-fonte hebraico ao título KJV v.0 (isso vive só na seção Condensed).
 *   - 3 StartDifferent (SD): 1Ki 18:34, 20:3, 22:21 — a fronteira do verso cai num "word
 *     diferente"; o TVTMS só marca nota + `Keep verse`. NÃO-verificáveis por regra: o TVTMS
 *     não carrega quantas palavras cruzam a fronteira (exigiria alinhamento textual). A ref
 *     embutida é a única verdade ali.
 *   - 2 NEEMIAS (KJV-only): Ne 7:67-68 — o verso só-KJV 7:68 ("cavalos", ausente no
 *     Leningrad) é absorvido em heb 7:67; a numeração desloca −1. Mapper (`Renumber`+`IfEmpty`)
 *     e ref embutida prendem o verso ambíguo a versos hebraicos diferentes.
 * BACKLOG: enriquecer os TÍTULOS via seção Condensed (fazer o mapper emitir o split
 * v.1→{v0,v1}) zeraria os 53 TM; os 3 SD permaneceriam irredutíveis. Fora do escopo de N5.
 * O baseline abaixo é EXATO: qualquer 59ª divergência, mudança de categoria, ou um dos 58
 * divergindo DIFERENTE = falha ruidosa. Ver `docs/plano-stepbible.md` Q1 e o retorno N5.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const tahotSrc = (file: string): string => path.join(dataDir, "sources", "stepbible-tahot", file);
const TAHOT_FILES = [
  "TAHOT_Gen-Deu.txt",
  "TAHOT_Jos-Est.txt",
  "TAHOT_Job-Sng.txt",
  "TAHOT_Isa-Mal.txt",
] as const;
const tvtmsPath = path.join(dataDir, "sources", "stepbible-tvtms", "TVTMS.txt");
const kjvPath = path.join(dataDir, "sources", "eng-kjv", "eng-kjv_usfx.xml");

const hasAll = [...TAHOT_FILES.map(tahotSrc), tvtmsPath, kjvPath].every((f) => existsSync(f));

/**
 * Nº EXATO de versos hebraicos verificados no sweep — atrelado ao sha256 do manifest
 * (TAHOT commit 0f60797…; TVTMS 8851a8b5…). Drift de fonte deve acusar aqui (ADR-008).
 */
const TOTAL_HEBREW_VERSES = 23213;

/**
 * Nº EXATO de versos hebraicos que divergem por vazamento de granularidade de fronteira
 * — atrelado ao manifest. Retrato do gate; mudança aqui = mudança de fonte/mapper
 * (reabrir Q1). Composição: 53 título-mesclado + 3 StartDifferent + 2 Neemias (= 58).
 */
const GRANULARITY_DIVERGENCES = 58;

/** Categoria da divergência aceita (documental; ver cabeçalho). */
type DivergenceCategory = "TM" | "SD" | "KJV-only";

interface KnownDivergence {
  /** Ref hebraica "Código C:V" (bookCode STEPBible: "Psa", "1Ki", "Neh"). */
  ref: string;
  category: DivergenceCategory;
  /** Conjunto produzido pela ref embutida (produtora), ordenado por string. */
  embedded: string[];
  /** Conjunto do mapper TVTMS, ordenado por string. */
  mapper: string[];
}

/**
 * Salmos TÍTULO-MESCLADO (53): heb v.1 = KJV {v.0 título, v.1 corpo}. Regra TVTMS
 * `EngTitleMerged+Hebrew | Keep verse` (Sl 133 por identidade — nenhuma regra ativa).
 * Padrão fechado: embutida {PSA_n_0, PSA_n_1}, mapper {PSA_n_1}.
 */
const TITLE_MERGED_PSALMS = [
  11, 14, 15, 16, 17, 23, 24, 25, 26, 27, 28, 29, 32, 35, 37, 50, 66, 72, 73, 74, 78, 79, 82,
  86, 87, 90, 98, 100, 101, 103, 109, 110, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129,
  130, 131, 132, 133, 134, 138, 139, 141, 143, 144, 145,
] as const;

/**
 * BASELINE CONGELADO das 58 divergências ACEITAS (dono, 2026-07-22, Opção A). O gate exige
 * que o sweep vivo produza EXATAMENTE este conjunto — ref, categoria e os dois conjuntos.
 * Qualquer 59ª, ausência, ou set diferente = falha ruidosa. As 5 não-Salmo estão explícitas
 * com a regra TVTMS aplicada anotada (ver cabeçalho e o retorno N5).
 */
const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  ...TITLE_MERGED_PSALMS.map(
    (n): KnownDivergence => ({
      ref: `Psa ${n}:1`,
      category: "TM",
      embedded: [`PSA_${n}_0`, `PSA_${n}_1`],
      mapper: [`PSA_${n}_1`],
    }),
  ),
  // StartDifferent: fronteira num "word diferente" (TVTMS `AllBibles | Keep verse` + nota).
  { ref: "1Ki 18:34", category: "SD", embedded: ["1KI_18_33", "1KI_18_34"], mapper: ["1KI_18_34"] },
  { ref: "1Ki 20:3", category: "SD", embedded: ["1KI_20_2", "1KI_20_3"], mapper: ["1KI_20_3"] },
  { ref: "1Ki 22:21", category: "SD", embedded: ["1KI_22_21", "1KI_22_22"], mapper: ["1KI_22_21"] },
  // Neemias (KJV-only): verso só-KJV 7:68 ("cavalos") absorvido no hebraico; numeração −1.
  { ref: "Neh 7:67", category: "KJV-only", embedded: ["NEH_7_67", "NEH_7_68"], mapper: ["NEH_7_67"] },
  { ref: "Neh 7:68", category: "KJV-only", embedded: ["NEH_7_69"], mapper: ["NEH_7_68", "NEH_7_69"] },
];

/** Uma linha TAHOT é "por palavra" quando a col 0 traz o marcador `#<pos>=`. */
const WORD_LINE_RE = /#\d+=/;

/**
 * Conjunto de canonical_ids KJV que a REF EMBUTIDA atribuiu a cada verso HEBRAICO.
 *
 * Re-percorre as linhas-por-palavra usando as MESMAS funções públicas do parser
 * (`parseTahotRef` → `stepCanonicalRef` → `makeCanonicalId`) — nenhuma semântica de ref
 * é duplicada, só a seleção de linha (idêntica a `walkTahot`: pula cabeçalho/resumo,
 * deuterocanônico e Qere de lexeme vazio). A chave hebraica é a MESMA de
 * `aggregateHebrewVerses` (`bookCode|hebChapter|hebVerse`), garantindo alinhamento 1:1.
 * Não há função exportada que devolva o par (hebRef, kjvRef), daí o re-walk.
 */
function embeddedKjvByHebVerse(tsv: string, into: Map<string, Set<string>>): void {
  for (const line of tsv.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const col0 = tab === -1 ? line : line.slice(0, tab);
    if (!WORD_LINE_RE.test(col0)) continue; // cabeçalho / licença / resumo "#"
    const ref = parseTahotRef(col0);
    const canonRef = stepCanonicalRef(ref);
    if (canonRef === null) continue; // deuterocanônico — pulado (como walkTahot)
    const lexeme = (line.split("\t")[1] ?? "").trim();
    if (lexeme === "") continue; // Qere que omite a palavra — sem lexeme (como walkTahot)
    const heb = ref.hebrew ?? { chapter: ref.chapter, verse: ref.verse };
    const key = `${ref.bookCode}|${heb.chapter}|${heb.verse}`;
    const kjvId = makeCanonicalId(canonRef);
    let set = into.get(key);
    if (set === undefined) {
      set = new Set();
      into.set(key, set);
    }
    set.add(kjvId);
  }
}

/**
 * `SourceInventory` HEBRAICA a partir dos agregados. Chaveada pelo código TVTMS/STEPBible
 * do livro (`ref.book` dos Tests já vem nesse código, ex.: "Psa"). Título = v.1 (ver
 * semântica fixada no topo): não existe verso 0, logo `hasTextBeforeV1` e `Title=Exist`
 * são sempre falsos na tradição hebraica.
 */
function hebrewInventory(aggregates: HebrewVerseAggregate[]): SourceInventory {
  const wordCounts = new Map<string, number>();
  const lastVerse = new Map<string, number>();
  for (const a of aggregates) {
    wordCounts.set(`${a.bookCode}|${a.chapter}|${a.verse}`, a.wordCount);
    const chapKey = `${a.bookCode}|${a.chapter}`;
    lastVerse.set(chapKey, Math.max(lastVerse.get(chapKey) ?? 0, a.verse));
  }
  return {
    exists(ref) {
      if (ref.subverse !== null || typeof ref.chapter !== "number") return false;
      if (ref.verse === "Title") return false; // hebraico: o título é o v.1, não um "Title"
      return wordCounts.has(`${ref.book}|${ref.chapter}|${ref.verse}`);
    },
    isLast(ref) {
      if (ref.subverse !== null || typeof ref.chapter !== "number" || typeof ref.verse !== "number") {
        return false;
      }
      return lastVerse.get(`${ref.book}|${ref.chapter}`) === ref.verse;
    },
    wordCount(ref) {
      if (ref.subverse !== null || typeof ref.chapter !== "number" || ref.verse === "Title") return 0;
      return wordCounts.get(`${ref.book}|${ref.chapter}|${ref.verse}`) ?? 0;
    },
    hasTextBeforeV1(book, chapter) {
      // Verso 0 = texto antes do v.1. Nunca existe no agregado hebraico (o título é o v.1).
      return typeof chapter === "number" && wordCounts.has(`${book}|${chapter}|0`);
    },
  };
}

const canonKey = (r: { book: string; chapter: number; verse: number }): string =>
  `${r.book}_${r.chapter}_${r.verse}`;

/** Divergência entre a ref embutida (produtora) e o mapper TVTMS num verso hebraico. */
interface Divergence {
  book: string;
  chapter: number;
  verse: number;
  isTitle: boolean;
  mapper: string[];
  embedded: string[];
  /**
   * "Vazamento de granularidade": ref embutida e mapper discordam apenas por versos
   * KJV ADJACENTES do mesmo capítulo (título v.0 ou fronteira ±1). Raiz única: o
   * STEPBible carimba por PALAVRA e distribui um verso hebraico por versos KJV vizinhos
   * (título-mesclado; StartDifferent; MergedFollVerse/IfEmpty), enquanto o mapper
   * TVTMS opera por VERSO ("Keep verse") e não reproduz o split. Não é erro do produtor.
   */
  granularity: boolean;
}

const versesOf = (ids: string[]): number[] =>
  ids.map((id) => Number(id.split("_")[2]));

/**
 * Verdadeiro quando a discordância é só de granularidade de fronteira (versos KJV
 * adjacentes do MESMO livro/capítulo, com ao menos um verso em comum) — o padrão
 * caracterizado no topo. Qualquer outra forma é divergência imprevista (bug/tradição
 * nova) e o gate a trata como não-caracterizada.
 */
function isGranularity(mapper: string[], embedded: string[]): boolean {
  const all = [...mapper, ...embedded];
  if (all.length === 0) return false;
  const books = new Set(all.map((id) => id.split("_").slice(0, 2).join("_"))); // BOOK_CHAPTER
  if (books.size !== 1) return false;
  const mSet = new Set(mapper);
  const shared = embedded.some((id) => mSet.has(id));
  if (!shared) return false;
  const verses = [...new Set(versesOf(all))].sort((a, b) => a - b);
  // Versos formam uma corrida contígua (0,1 | 33,34 | 68,69 …).
  return verses.every((v, i) => i === 0 || v === (verses[i - 1] as number) + 1);
}

describe.skipIf(!hasAll)("gate de versificação TVTMS × ref embutida (TAHOT real)", () => {
  let aggregates: HebrewVerseAggregate[];
  let embedded: Map<string, Set<string>>;
  let mapper: TvtmsMapper;
  let divergences: Divergence[];
  let verified: number;

  beforeAll(() => {
    aggregates = [];
    embedded = new Map();
    for (const file of TAHOT_FILES) {
      const tsv = readFileSync(tahotSrc(file), "utf8");
      aggregates.push(...aggregateHebrewVerses(tsv));
      embeddedKjvByHebVerse(tsv, embedded);
    }
    const { rules } = parseTvtmsExpanded(readFileSync(tvtmsPath, "utf8"));
    const kjv = parseUsfx(readFileSync(kjvPath, "utf8"));
    mapper = new TvtmsMapper(rules, hebrewInventory(aggregates), usfxStandardInventory(kjv));

    // SWEEP: para CADA verso hebraico, toKjv(hebRef,"Hebrew") vs canonical_ids da ref embutida.
    divergences = [];
    verified = 0;
    for (const a of aggregates) {
      const base = { book: a.bookCode, chapter: a.chapter, verse: a.verse, isTitle: a.isTitle };
      const usfm = TVTMS_TO_USFM[a.bookCode];
      const expected = [...(embedded.get(`${a.bookCode}|${a.chapter}|${a.verse}`) ?? new Set<string>())].sort();
      if (usfm === undefined) {
        divergences.push({ ...base, mapper: ["<sem-USFM>"], embedded: expected, granularity: false });
        continue;
      }
      let mapped: string[];
      try {
        mapped = mapper
          .toKjv({ book: usfm, chapter: a.chapter, verse: a.verse, tradition: "Hebrew" })
          .map(canonKey)
          .sort();
      } catch (err) {
        divergences.push({ ...base, mapper: [`<throw: ${(err as Error).message}>`], embedded: expected, granularity: false });
        continue;
      }
      verified += 1;
      const embSet = new Set(expected);
      if (mapped.length !== expected.length || mapped.some((id) => !embSet.has(id))) {
        divergences.push({ ...base, mapper: mapped, embedded: expected, granularity: isGranularity(mapped, expected) });
      }
    }
  });

  it("os dois walks concordam no conjunto de versos hebraicos (agregado ↔ ref embutida)", () => {
    // Alinhamento 1:1: cada verso agregado tem um conjunto KJV embutido, e vice-versa.
    // Guarda contra divergência de skip entre `aggregateHebrewVerses` e o re-walk local.
    expect(embedded.size).toBe(aggregates.length);
    const missing = aggregates.filter((a) => !embedded.has(`${a.bookCode}|${a.chapter}|${a.verse}`));
    expect(missing.map((a) => `${a.bookCode} ${a.chapter}:${a.verse}`)).toEqual([]);
    // Nenhum verso hebraico com verso 0 (o título vira v.1); SourceRef exige verso ≥ 1.
    const verseZero = aggregates.filter((a) => a.verse < 1);
    expect(verseZero.map((a) => `${a.bookCode} ${a.chapter}:${a.verse}`)).toEqual([]);
  });

  it("SWEEP invariantes (VERDE): cobertura total + toda divergência é granularidade caracterizada", () => {
    const fmt = (d: Divergence): string =>
      `heb ${d.book} ${d.chapter}:${d.verse} → mapper {${d.mapper.join(",")}} vs embutida {${d.embedded.join(",")}}`;

    // Cobertura: nº EXATO de versos hebraicos varridos, atrelado ao manifest (ADR-008).
    expect(verified).toBe(TOTAL_HEBREW_VERSES);
    expect(verified).toBe(aggregates.length);

    // Nenhuma divergência IMPREVISTA: toda discordância é vazamento de granularidade de
    // fronteira (versos KJV adjacentes; ver `isGranularity`). Qualquer outra forma seria
    // bug do produtor/mapper ou tradição nova e travaria a ingestão na hora.
    const uncharacterized = divergences.filter((d) => !d.granularity);
    expect(
      uncharacterized.length,
      `${uncharacterized.length} divergência(s) NÃO-caracterizada(s) (imprevista):\n  ${uncharacterized.slice(0, 25).map(fmt).join("\n  ")}`,
    ).toBe(0);
    // Nº EXATO de versos com vazamento de granularidade (atrelado ao manifest).
    expect(divergences.length).toBe(GRANULARITY_DIVERGENCES);
  });

  it("GATE ADR-002/Q1 — concordância MÓDULO GRANULARIDADE: exatamente as 58 conhecidas", () => {
    // Dono aprovou (2026-07-22, Opção A) aceitar a categoria: o gate passa quando o desvio
    // mapper × ref embutida é EXATAMENTE o baseline congelado `KNOWN_DIVERGENCES` — ref,
    // categoria e os DOIS conjuntos. 59ª divergência, ausência, mudança de categoria ou um
    // dos 58 divergindo diferente ⇒ falha ruidosa. Ver cabeçalho para a análise por categoria.
    const refOf = (d: Divergence): string => `${d.book} ${d.chapter}:${d.verse}`;
    const live = new Map(divergences.map((d) => [refOf(d), d]));
    const baseline = new Map(KNOWN_DIVERGENCES.map((e) => [e.ref, e]));

    // (1) Mesmo conjunto de refs — nada a mais (59ª) nem a menos (uma que sumiu).
    expect([...live.keys()].sort(), "refs divergentes vivas vs baseline").toEqual(
      [...baseline.keys()].sort(),
    );

    // (2) Para cada ref conhecida: os dois conjuntos batem EXATAMENTE (divergir diferente falha).
    for (const [ref, exp] of baseline) {
      const got = live.get(ref);
      expect(got, `divergência conhecida sumiu do sweep: ${ref}`).toBeDefined();
      if (!got) continue;
      expect(got.embedded, `${ref}: conjunto da ref embutida mudou`).toEqual(exp.embedded);
      expect(got.mapper, `${ref}: conjunto do mapper TVTMS mudou`).toEqual(exp.mapper);
    }

    // (3) Categoria TM ⇔ isTitle no dado vivo (drift de categoria TM/não-TM falha ruidoso).
    for (const e of KNOWN_DIVERGENCES) {
      const got = live.get(e.ref);
      if (!got) continue;
      expect(got.isTitle, `${e.ref}: isTitle vs categoria ${e.category}`).toBe(e.category === "TM");
    }

    // (4) Composição documentada congelada: 53 TM + 3 SD + 2 KJV-only = 58.
    const count = (c: DivergenceCategory): number =>
      KNOWN_DIVERGENCES.filter((e) => e.category === c).length;
    expect(count("TM")).toBe(53);
    expect(count("SD")).toBe(3);
    expect(count("KJV-only")).toBe(2);
    expect(KNOWN_DIVERGENCES.length).toBe(GRANULARITY_DIVERGENCES);
  });

  it("âncora — título do Sl 3 (heb 3:1, isTitle) → KJV PSA_3_0 (verso 0)", () => {
    const title = aggregates.find((a) => a.bookCode === "Psa" && a.chapter === 3 && a.verse === 1);
    expect(title).toMatchObject({ isTitle: true });
    expect(embedded.get("Psa|3|1")).toEqual(new Set(["PSA_3_0"]));
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 0, subverse: null },
    ]);
  });

  it("âncora — Sl 3:2 heb → PSA_3_1 (título empurra a numeração +1)", () => {
    expect(embedded.get("Psa|3|2")).toEqual(new Set(["PSA_3_1"]));
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 2, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 1, subverse: null },
    ]);
  });

  it("âncora — Malaquias heb 3:19-24 → MAL_4_1..6 (hebraico não tem cap. 4)", () => {
    for (let hv = 19; hv <= 24; hv += 1) {
      const kjvVerse = hv - 18; // 3:19→4:1 … 3:24→4:6
      expect(embedded.get(`Mal|3|${hv}`), `Mal 3:${hv} embutida`).toEqual(
        new Set([`MAL_4_${kjvVerse}`]),
      );
      expect(
        mapper.toKjv({ book: "MAL", chapter: 3, verse: hv, tradition: "Hebrew" }),
        `Mal 3:${hv} mapper`,
      ).toEqual([{ book: "MAL", chapter: 4, verse: kjvVerse, subverse: null }]);
    }
    // Ml 3:18 (antes da fronteira) é identidade.
    expect(mapper.toKjv({ book: "MAL", chapter: 3, verse: 18, tradition: "Hebrew" })).toEqual([
      { book: "MAL", chapter: 3, verse: 18, subverse: null },
    ]);
  });

  it("âncora — Joel heb 3:1-5 → JOL_2_28..32 e heb cap. 4 → JOL cap. 3", () => {
    for (let hv = 1; hv <= 5; hv += 1) {
      const kjvVerse = hv + 27; // 3:1→2:28 … 3:5→2:32
      expect(embedded.get(`Jol|3|${hv}`), `Jol 3:${hv} embutida`).toEqual(
        new Set([`JOL_2_${kjvVerse}`]),
      );
      expect(
        mapper.toKjv({ book: "JOL", chapter: 3, verse: hv, tradition: "Hebrew" }),
        `Jol 3:${hv} mapper`,
      ).toEqual([{ book: "JOL", chapter: 2, verse: kjvVerse, subverse: null }]);
    }
    // Cap. 4 hebraico inteiro → cap. 3 KJV (mesma numeração de verso).
    const jolChap4 = aggregates.filter((a) => a.bookCode === "Jol" && a.chapter === 4);
    expect(jolChap4.length).toBeGreaterThan(0);
    for (const a of jolChap4) {
      expect(embedded.get(`Jol|4|${a.verse}`), `Jol 4:${a.verse} embutida`).toEqual(
        new Set([`JOL_3_${a.verse}`]),
      );
      expect(
        mapper.toKjv({ book: "JOL", chapter: 4, verse: a.verse, tradition: "Hebrew" }),
        `Jol 4:${a.verse} mapper`,
      ).toEqual([{ book: "JOL", chapter: 3, verse: a.verse, subverse: null }]);
    }
  });

  it("âncora — capítulo sem divergência (Gênesis 1): identidade heb == KJV", () => {
    // NB: Genesis NÃO é identidade no LIVRO — o hebraico tem a fronteira 31/32
    // deslocada (heb Gn 32:1 = KJV Gn 31:55). O cap. 1 é identidade limpa; ambos os
    // lados (embutida e mapper) concordam nele verso a verso.
    const gen1 = aggregates.filter((a) => a.bookCode === "Gen" && a.chapter === 1);
    expect(gen1.length).toBeGreaterThan(0);
    for (const a of gen1) {
      expect(embedded.get(`Gen|1|${a.verse}`), `Gen 1:${a.verse} embutida`).toEqual(
        new Set([`GEN_1_${a.verse}`]),
      );
      expect(
        mapper.toKjv({ book: "GEN", chapter: 1, verse: a.verse, tradition: "Hebrew" }),
        `Gen 1:${a.verse} mapper`,
      ).toEqual([{ book: "GEN", chapter: 1, verse: a.verse, subverse: null }]);
    }
  });
});

if (!hasAll) {
  it("fontes TAHOT/TVTMS/KJV ausentes — gate de versificação PULADO (ver manifest.json)", () => {
    expect(hasAll).toBe(false);
  });
}
