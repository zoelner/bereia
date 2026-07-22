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
 * O gate exige CONCORDÂNCIA 100% entre `toKjv(hebRef,"Hebrew")` e o conjunto de
 * canonical_ids que a ref embutida atribuiu às palavras daquele verso hebraico.
 * Comparação é CONJUNTO → CONJUNTO (o mapper devolve 0..n refs em splits/merges; verso
 * 0 = título) — nunca colapsada à força para 1:1. Divergência genuína NÃO é "consertada"
 * ajustando o esperado: é reportada (o dono precisa vê-la). Sem os arquivos (CI), a suíte
 * é PULADA — nunca verde falso (ADR-006/ADR-008).
 *
 * RESULTADO (2026-07-22, gate NÃO-100% — FINDING para o dono):
 *   23.213 versos hebraicos varridos; 23.155 concordam EXATO; 58 divergem — TODOS por
 *   VAZAMENTO DE GRANULARIDADE (verso × palavra), NÃO por erro do produtor. A premissa do
 *   plano ("todo título de Salmo se comporta como o Sl 3, deslocando +1") é FALSA no dado:
 *   só ~53 Salmos deslocam; os outros 53 são "título-mesclado" (heb v.1 = KJV {v.0 título,
 *   v.1 corpo}). A ref embutida (produtora do canonical_id por Q1) carimba por palavra e
 *   roteia o título ao v.0 e o corpo ao v.1 — CORRETO. O mapper TVTMS opera por verso
 *   ("Keep verse"/EngTitleMerged) e não emite o v.0 — INCOMPLETO, não errado. Mesmo padrão
 *   em 5 versos de fronteira (1Ki 18:34/20:3/22:21 StartDifferent; Ne 7:67-68 verso só-KJV
 *   "cavalos" absorvido no hebraico). Resolver = decisão do dono (aceitar a categoria, já
 *   fechada e pinada abaixo, ou enriquecer o mapper com a seção Condensed do TVTMS): FORA
 *   do escopo deste nó (não edito o mapper). Ver `docs/plano-stepbible.md` Q1 e o retorno N5.
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
 * — atrelado ao manifest. Retrato do FINDING do gate; mudança aqui = mudança de
 * fonte/mapper (reabrir Q1). Composição observada (2026-07-22):
 *   53 Salmos título-mesclado (heb v.1 = KJV {v.0 título, v.1 corpo})
 *    5 fronteira/merge: 1Ki 18:34, 1Ki 20:3, 1Ki 22:21 (StartDifferent);
 *      Ne 7:67, 7:68 (verso só-KJV "cavalos" absorvido no hebraico — MergedFollVerse).
 */
const GRANULARITY_DIVERGENCES = 58;

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

  it("GATE ADR-002/Q1 — concordância 100% mapper × ref embutida (FALHA: granularidade)", () => {
    // FINDING (o dono precisa ver): a verificação independente NÃO fecha 100%. O mapper
    // TVTMS (verso a verso) diverge da ref embutida (palavra a palavra, produtora do
    // canonical_id por Q1) em ${GRANULARITY_DIVERGENCES} versos hebraicos, TODOS por
    // vazamento de granularidade de fronteira. A ref embutida está CORRETA (roteia cada
    // palavra ao seu verso KJV real); o mapper não consegue reproduzir o split verso→2KJV
    // nesses casos (Keep verse / IfEmpty). Categorias:
    //   (a) Salmo título-mesclado: heb v.1 = KJV {v.0 título, v.1 corpo} — ex.: Sl 72:1.
    //   (b) StartDifferent: fronteira num "word diferente" — 1Ki 18:34, 20:3, 22:21.
    //   (c) MergedFollVerse/IfEmpty: verso só-KJV (ex.: Ne 7:68, "cavalos") absorvido no
    //       hebraico — desloca a numeração; mapper e embutida discordam por 1 verso.
    // Resolver está FORA do escopo deste nó (não posso editar o mapper): é decisão do dono
    // — aceitar a categoria (verificação "modulo granularidade") ou enriquecer o mapper com
    // a seção Condensed do TVTMS (título/fronteiras a nível de palavra). Ver notes N5.
    const byCat = new Map<string, Divergence[]>();
    for (const d of divergences) {
      const cat = d.isTitle ? "titulo-mesclado" : "fronteira/merge";
      byCat.set(cat, [...(byCat.get(cat) ?? []), d]);
    }
    const summary = [...byCat.entries()]
      .map(([cat, ds]) => `  [${cat}] ${ds.length}: ${ds.map((d) => `${d.book} ${d.chapter}:${d.verse}`).join(", ")}`)
      .join("\n");
    expect(
      divergences.length,
      `GATE NÃO-100% — ${divergences.length} divergência(s) mapper × ref embutida (granularidade):\n${summary}`,
    ).toBe(0);
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
