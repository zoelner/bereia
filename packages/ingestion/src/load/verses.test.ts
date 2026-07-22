import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalVerseSchema,
  verseTextSchema,
  type CanonicalId,
  type CanonicalVerse,
  type UsfmBook,
} from "@bereia/core";
import type { UsfxBible, UsfxChapter, UsfxVerse } from "../parsers/usfx/parser.js";
import type { MappedRef, SourceRef, VersificationMapper } from "../parsers/tvtms/contract.js";
import { usfxSourceInventory, usfxStandardInventory } from "../parsers/usfx/inventory.js";
import { AmbiguousMappingError, loadTvtms } from "../parsers/tvtms.js";
import { parseUsfx } from "../parsers/usfx/parser.js";
import {
  buildCanonicalVerses,
  buildVerseTexts,
  canonicalIdSet,
  type VerseTextsResult,
} from "./verses.js";
import {
  readCanonicalVerses,
  readVerseTexts,
  writeCanonicalVerses,
  writeVerseTexts,
} from "./jsonl.js";
import { compareCanonicalVerse, compareVerseText } from "./order.js";

/**
 * Testes ancorados em requisito (ADR-008). Unit: Bíblias USFX SINTÉTICAS
 * (estrutura montada à mão, textos placeholders neutros marcados como mock —
 * NUNCA conteúdo teológico inventado) exercitando o contrato dos ports
 * (`buildCanonicalVerses`/`buildVerseTexts`) e das políticas fixadas
 * (verso 0 OQ-2, descarte fora-do-mestre OQ-4, explosão de colisão/ponte,
 * determinismo de ordem). Integração: números EXATOS atrelados ao sha256 do
 * `manifest.json`, contra as fontes reais (pula quando faltam — ADR-006, nunca
 * verde falso; rode com DATA_DIR do repo).
 */

// --- helpers de estrutura sintética (mock) --------------------------------

interface VerseSpec {
  v: number;
  /** Texto mock (placeholder neutro, sem conteúdo teológico). "" = marcador sem conteúdo. */
  text: string;
  /** Fim da ponte (default = v). */
  end?: number;
}
interface ChapterSpec {
  n: number;
  title?: string;
  verses: VerseSpec[];
}
interface BookSpec {
  book: UsfmBook;
  chapters: ChapterSpec[];
}

/** Monta um `UsfxBible` a partir de uma spec declarativa (ordem preservada — para testar sort). */
function makeBible(spec: BookSpec[]): UsfxBible {
  const books = new Map<UsfmBook, Map<number, UsfxChapter>>();
  for (const b of spec) {
    const chapters = new Map<number, UsfxChapter>();
    for (const c of b.chapters) {
      const verses = new Map<number, UsfxVerse>();
      let lastVerse = 0;
      for (const vs of c.verses) {
        const end = vs.end ?? vs.v;
        const uv: UsfxVerse = { book: b.book, chapter: c.n, verse: vs.v, verseEnd: end, text: vs.text };
        for (let k = vs.v; k <= end; k++) verses.set(k, uv);
        lastVerse = Math.max(lastVerse, end);
      }
      chapters.set(c.n, { title: c.title ?? null, verses, lastVerse });
    }
    books.set(b.book, chapters);
  }
  return { books, skippedBooks: [] };
}

/** Mapper de identidade (a fonte já está na versificação-mestre). */
const identityMapper: VersificationMapper = {
  toKjv: (ref: SourceRef): MappedRef[] => [
    { book: ref.book, chapter: ref.chapter, verse: ref.verse, subverse: null },
  ],
};

/** Mapper programável por chave `BOOK c:v` — para testar split/merge/remap/vazio. */
function scriptedMapper(script: Record<string, MappedRef[]>): VersificationMapper {
  return {
    toKjv: (ref: SourceRef): MappedRef[] => {
      const key = `${ref.book} ${ref.chapter}:${ref.verse}`;
      return script[key] ?? [{ book: ref.book, chapter: ref.chapter, verse: ref.verse, subverse: null }];
    },
  };
}

const cid = (s: string): CanonicalId => s as CanonicalId;

// --- unit: buildCanonicalVerses -------------------------------------------

describe("buildCanonicalVerses — inventário-mestre a partir da KJV", () => {
  it("enumera corpos + título verso 0 (OQ-2) com canonStatus/theologicalCategory fixos", () => {
    const kjv = makeBible([
      { book: "PSA", chapters: [{ n: 3, title: "mock título PSA 3", verses: [{ v: 1, text: "mock" }, { v: 2, text: "mock" }] }] },
    ]);
    const out = buildCanonicalVerses(kjv);
    expect(out).toEqual([
      { id: "PSA_3_0", book: "PSA", chapter: 3, verse: 0, canonStatus: "protestant", theologicalCategory: null },
      { id: "PSA_3_1", book: "PSA", chapter: 3, verse: 1, canonStatus: "protestant", theologicalCategory: null },
      { id: "PSA_3_2", book: "PSA", chapter: 3, verse: 2, canonStatus: "protestant", theologicalCategory: null },
    ]);
    // Zod: cada linha casa o schema do core.
    for (const v of out) expect(canonicalVerseSchema.parse(v)).toEqual(v);
  });

  it("capítulo sem título NÃO gera verso 0", () => {
    const kjv = makeBible([{ book: "PSA", chapters: [{ n: 1, verses: [{ v: 1, text: "mock" }] }] }]);
    expect(buildCanonicalVerses(kjv).map((v) => v.id)).toEqual(["PSA_1_1"]);
  });

  it("ordena determinística e totalmente, independente da ordem dos Map de entrada", () => {
    const scrambled = makeBible([
      {
        book: "GEN",
        chapters: [
          { n: 2, verses: [{ v: 2, text: "mock" }, { v: 1, text: "mock" }] },
          { n: 1, verses: [{ v: 3, text: "mock" }, { v: 1, text: "mock" }] },
        ],
      },
    ]);
    expect(buildCanonicalVerses(scrambled).map((v) => v.id)).toEqual([
      "GEN_1_1",
      "GEN_1_3",
      "GEN_2_1",
      "GEN_2_2",
    ]);
  });

  it("verso em ponte (verse != verseEnd) EXPLODE (cânon-66 não deveria ter pontes)", () => {
    const kjv = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock", end: 2 }] }] }]);
    expect(() => buildCanonicalVerses(kjv)).toThrow(/verso em ponte/);
  });

  it("re-run é byte-idêntico e sobrevive ao round-trip JSONL (determinismo)", () => {
    const kjv = makeBible([
      { book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock" }, { v: 2, text: "mock" }] }] },
      { book: "PSA", chapters: [{ n: 3, title: "mock título", verses: [{ v: 1, text: "mock" }] }] },
    ]);
    const a = writeCanonicalVerses(buildCanonicalVerses(kjv));
    const b = writeCanonicalVerses(buildCanonicalVerses(kjv));
    expect(a).toBe(b);
    expect(readCanonicalVerses(a)).toEqual(buildCanonicalVerses(kjv));
  });
});

// --- unit: buildVerseTexts ------------------------------------------------

describe("buildVerseTexts — verse_texts de uma tradução", () => {
  const kjv = makeBible([
    { book: "PSA", chapters: [{ n: 3, title: "mock título PSA 3", verses: [{ v: 1, text: "mock 3:1" }] }] },
    { book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock 1:1" }, { v: 2, text: "mock 1:2" }] }] },
  ]);
  const inventory = canonicalIdSet(buildCanonicalVerses(kjv));

  it("emite corpo + título (verso 0, OQ-2) com os metadados default do plano §3.3", () => {
    const { verseTexts, stats } = buildVerseTexts({
      source: kjv,
      translation: "MOCK",
      versificationTradition: "Hebrew",
      mapper: identityMapper,
      inventory,
    });
    expect(stats.dropped).toEqual([]);
    expect(stats.emitted).toBe(4); // 3 corpos (PSA_3_1, GEN_1_1, GEN_1_2) + 1 título (PSA_3_0)
    const byId = new Map(verseTexts.map((v) => [v.canonicalId, v]));
    expect(byId.get(cid("PSA_3_0"))).toEqual({
      canonicalId: "PSA_3_0",
      translation: "MOCK",
      text: "mock título PSA 3",
      embeddingModel: null,
      thematicTags: [],
      culturalContext: null,
      humanReviewed: false,
      reviewedBy: null,
      authorizedLevels: ["public"],
    });
    expect(byId.get(cid("GEN_1_1"))?.text).toBe("mock 1:1");
    for (const v of verseTexts) expect(verseTextSchema.parse(v)).toEqual(v);
  });

  it("ordena por (referência canônica, translation) via comparador do N4", () => {
    const { verseTexts } = buildVerseTexts({
      source: kjv,
      translation: "MOCK",
      versificationTradition: "Hebrew",
      mapper: identityMapper,
      inventory,
    });
    expect(verseTexts.map((v) => v.canonicalId)).toEqual(["GEN_1_1", "GEN_1_2", "PSA_3_0", "PSA_3_1"]);
    const sorted = [...verseTexts].sort(compareVerseText);
    expect(verseTexts).toEqual(sorted);
  });

  it("verso com texto vazio é pulado (marcador sem conteúdo, ex.: At 8:37 na WEB)", () => {
    const src = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock 1:1" }, { v: 2, text: "" }] }] }]);
    const inv = canonicalIdSet(buildCanonicalVerses(kjv));
    const { verseTexts } = buildVerseTexts({ source: src, translation: "MOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory: inv });
    expect(verseTexts.map((v) => v.canonicalId)).toEqual(["GEN_1_1"]);
  });

  it("mapeamento 1→n (split): uma linha por verso-alvo, todas dentro do mestre", () => {
    const master = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "m" }, { v: 2, text: "m" }] }] }]);
    const inv = canonicalIdSet(buildCanonicalVerses(master));
    const src = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock split" }] }] }]);
    const mapper = scriptedMapper({
      "GEN 1:1": [
        { book: "GEN", chapter: 1, verse: 1, subverse: "a" },
        { book: "GEN", chapter: 1, verse: 2, subverse: "b" },
      ],
    });
    const { verseTexts } = buildVerseTexts({ source: src, translation: "MOCK", versificationTradition: "Hebrew", mapper, inventory: inv });
    expect(verseTexts.map((v) => v.canonicalId)).toEqual(["GEN_1_1", "GEN_1_2"]);
    expect(verseTexts.every((v) => v.text === "mock split")).toBe(true);
  });

  it("colisão (canonicalId, translation) por merge de versificação EXPLODE (ambiguidade nova)", () => {
    const src = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock a" }, { v: 2, text: "mock b" }] }] }]);
    const mapper = scriptedMapper({
      "GEN 1:1": [{ book: "GEN", chapter: 1, verse: 1, subverse: null }],
      "GEN 1:2": [{ book: "GEN", chapter: 1, verse: 1, subverse: null }],
    });
    expect(() =>
      buildVerseTexts({ source: src, translation: "MOCK", versificationTradition: "Hebrew", mapper, inventory }),
    ).toThrow(/duplicada|colisão/);
  });

  it("mapeamento para 0 versos KJV EXPLODE (não descarta silenciosamente)", () => {
    const src = makeBible([{ book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock" }] }] }]);
    const mapper: VersificationMapper = { toKjv: () => [] };
    expect(() =>
      buildVerseTexts({ source: src, translation: "MOCK", versificationTradition: "Hebrew", mapper, inventory }),
    ).toThrow(/0 versos KJV/);
  });

  it("alvo fora do mestre é DESCARTADO com estatística (OQ-4), FK preservada nos emitidos", () => {
    // ROM 14:24 (doxologia da WEB) mapeia identidade p/ ROM_14_24 — fora do mestre.
    const src = makeBible([
      { book: "ROM", chapters: [{ n: 14, verses: [{ v: 23, text: "mock 14:23" }, { v: 24, text: "mock doxologia" }] }] },
    ]);
    const inv = new Set<CanonicalId>([cid("ROM_14_23")]);
    const { verseTexts, stats } = buildVerseTexts({
      source: src,
      translation: "WEBMOCK",
      versificationTradition: "Hebrew",
      mapper: identityMapper,
      inventory: inv,
      maxDropRate: 1, // corpus mínimo: aqui prova-se o MECANISMO de descarte, não o teto
    });
    expect(verseTexts.map((v) => v.canonicalId)).toEqual(["ROM_14_23"]);
    expect(stats.dropped).toEqual([{ canonicalId: "ROM_14_24", origin: "ROM 14:24" }]);
    for (const v of verseTexts) expect(inv.has(v.canonicalId)).toBe(true);
  });

  it("taxa de descarte acima do teto EXPLODE ruidosamente (OQ-4)", () => {
    const src = makeBible([
      { book: "GEN", chapters: [{ n: 1, verses: [{ v: 1, text: "mock" }, { v: 2, text: "mock" }, { v: 3, text: "mock" }] }] },
    ]);
    const inv = new Set<CanonicalId>([cid("GEN_1_1")]); // 2 de 3 caem fora
    expect(() =>
      buildVerseTexts({ source: src, translation: "MOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory: inv, maxDropRate: 0.005 }),
    ).toThrow(/taxa de descarte/);
  });

  it("título de tradução fora do inventário-mestre é descartado (ex.: PSA 119 na WEB)", () => {
    const src = makeBible([{ book: "PSA", chapters: [{ n: 119, title: "mock ALEPH", verses: [{ v: 1, text: "mock 119:1" }] }] }]);
    const inv = new Set<CanonicalId>([cid("PSA_119_1")]); // KJV não tem título em PSA 119
    const { verseTexts, stats } = buildVerseTexts({ source: src, translation: "WEBMOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory: inv, maxDropRate: 1 });
    expect(verseTexts.map((v) => v.canonicalId)).toEqual(["PSA_119_1"]);
    expect(stats.dropped).toEqual([{ canonicalId: "PSA_119_0", origin: "título PSA 119" }]);
  });

  it("re-run byte-idêntico e round-trip JSONL (determinismo)", () => {
    const a = writeVerseTexts(buildVerseTexts({ source: kjv, translation: "MOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory }).verseTexts);
    const b = writeVerseTexts(buildVerseTexts({ source: kjv, translation: "MOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory }).verseTexts);
    expect(a).toBe(b);
    const parsed = readVerseTexts(a);
    expect(parsed).toEqual(buildVerseTexts({ source: kjv, translation: "MOCK", versificationTradition: "Hebrew", mapper: identityMapper, inventory }).verseTexts);
  });
});

// --- integração: fontes REAIS, números atrelados ao sha256 do manifest -----

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", rel);

const FILES = {
  manifest: src("manifest.json"),
  kjv: src("eng-kjv/eng-kjv_usfx.xml"),
  web: src("eng-web/engwebp_usfx.xml"),
  blivre: src("por-biblialivre/porbr2018_usfx.xml"),
  tvtms: src("stepbible-tvtms/TVTMS.txt"),
};
const hasAll = Object.values(FILES).every((f) => existsSync(f));

/**
 * sha256 do `manifest.json` — âncora ADR-008: os números abaixo valem para
 * ESTAS fontes pinadas. Se o manifest mudar (fonte re-baixada/atualizada) o
 * hash quebra ANTES de a suíte assertar contagens estagnadas.
 */
const MANIFEST_SHA256 = "ccc319094d9c7503609ae9de849f9991a8d5ce97c5c8cefbbc1b362c256c83a6";

/** Todas as tradições seguem a versificação hebraica do AT — ver nota de topo de verses.ts. */
const TRADITION = "Hebrew";

/** Números EXATOS atrelados ao manifest acima (levantados do dado real). */
const CANONICAL_VERSES_TOTAL = 31_218; // 31 102 corpos + 116 títulos de Salmo (verso 0)
const PSALM_TITLES = 116;
const BODY_VERSES = 31_102;
const VERSE_TEXTS = {
  KJV: { emitted: 31_218, dropped: [] as string[] },
  BLIVRE: { emitted: 31_217, dropped: [] as string[] },
  WEB: { emitted: 31_211, dropped: ["PSA_119_0", "ROM_14_24", "ROM_14_25", "ROM_14_26"] },
} as const;

/** As 5 refs de Ester onde os testes de conteúdo deixam 2 regras TVTMS ativas divergentes. */
const ESTHER_AMBIGUOUS: readonly (readonly [number, number])[] = [
  [1, 1],
  [3, 13],
  [4, 17],
  [8, 12],
  [10, 3],
];

interface BuiltTranslation {
  name: string;
  bible: UsfxBible;
  mapper: VersificationMapper;
  result: VerseTextsResult;
}

/**
 * Parse pesado (3 USFX grandes + TVTMS) e builds feitos UMA vez em `beforeAll`,
 * compartilhados por todos os testes — sem isso o run completo re-parseia por
 * teste e estoura o testTimeout sob carga do pool (flakiness). `testTimeout`
 * explícito porque os re-runs em máquina carregada não podem reprovar o gate.
 */
describe.skipIf(!hasAll)(
  "integração real — canonical_verses + verse_texts (manifest pinado)",
  () => {
    let canonicalVerses: CanonicalVerse[];
    let inventory: ReadonlySet<CanonicalId>;
    const built: BuiltTranslation[] = [];

    const pick = (name: string): BuiltTranslation => {
      const b = built.find((x) => x.name === name);
      if (b === undefined) throw new Error(`tradução não montada no beforeAll: ${name}`);
      return b;
    };

    beforeAll(() => {
      const kjv = parseUsfx(readFileSync(FILES.kjv, "utf8"));
      const std = usfxStandardInventory(kjv);
      const tvtms = readFileSync(FILES.tvtms, "utf8");
      canonicalVerses = buildCanonicalVerses(kjv);
      inventory = canonicalIdSet(canonicalVerses);
      const sources: readonly { name: string; file: string }[] = [
        { name: "KJV", file: FILES.kjv },
        { name: "WEB", file: FILES.web },
        { name: "BLIVRE", file: FILES.blivre },
      ];
      for (const { name, file } of sources) {
        const bible = name === "KJV" ? kjv : parseUsfx(readFileSync(file, "utf8"));
        const mapper = loadTvtms(tvtms, usfxSourceInventory(bible), std);
        const result = buildVerseTexts({
          source: bible,
          translation: name,
          versificationTradition: TRADITION,
          mapper,
          inventory,
        });
        built.push({ name, bible, mapper, result });
      }
    }, 120_000);

    it("o manifest pinado casa o sha256 esperado (âncora ADR-008)", () => {
      const hash = createHash("sha256").update(readFileSync(FILES.manifest)).digest("hex");
      expect(hash).toBe(MANIFEST_SHA256);
    });

    it(`canonical_verses = ${CANONICAL_VERSES_TOTAL} (${BODY_VERSES} corpos + ${PSALM_TITLES} títulos v.0)`, () => {
      const cv = canonicalVerses;
      expect(cv.length).toBe(CANONICAL_VERSES_TOTAL);
      expect(cv.filter((v) => v.verse === 0).length).toBe(PSALM_TITLES);
      expect(cv.filter((v) => v.verse > 0).length).toBe(BODY_VERSES);
      // canon fechado: 66 livros, todos protestant.
      expect(new Set(cv.map((v) => v.book)).size).toBe(66);
      expect(cv.every((v) => v.canonStatus === "protestant" && v.theologicalCategory === null)).toBe(true);
      // ordenado e sem id duplicado (determinismo + chave única).
      expect([...cv].sort(compareCanonicalVerse)).toEqual(cv);
      expect(new Set(cv.map((v) => v.id)).size).toBe(cv.length);
    });

    it("verse_texts por tradução: contagens exatas + descartes fora-do-mestre (OQ-4)", () => {
      for (const translation of ["KJV", "WEB", "BLIVRE"] as const) {
        const { verseTexts, stats } = pick(translation).result;
        expect(stats.emitted, translation).toBe(VERSE_TEXTS[translation].emitted);
        expect(verseTexts.length, translation).toBe(VERSE_TEXTS[translation].emitted);
        expect([...stats.dropped.map((d) => d.canonicalId)].sort(), `${translation} dropped`).toEqual(
          [...VERSE_TEXTS[translation].dropped].sort(),
        );
        expect(stats.dropRate, translation).toBeLessThan(0.005);
      }
    });

    it("FK e unicidade: todo verse_text ∈ inventário-mestre; (canonicalId, translation) único", () => {
      for (const translation of ["KJV", "WEB", "BLIVRE"] as const) {
        const { verseTexts } = pick(translation).result;
        for (const v of verseTexts) {
          expect(inventory.has(v.canonicalId), `${translation} FK ${v.canonicalId}`).toBe(true);
        }
        expect(new Set(verseTexts.map((v) => v.canonicalId)).size, translation).toBe(verseTexts.length);
      }
    });

    it("âncoras: PSA_3_0 (título de Salmo) e At 8:37 (TR — KJV/BLIVRE sim, WEB não)", () => {
      expect(inventory.has(cid("PSA_3_0"))).toBe(true);
      expect(inventory.has(cid("ACT_8_37"))).toBe(true);

      // PSA_3_0: linha de título indexável em cada tradução que o tem (OQ-2).
      for (const translation of ["KJV", "WEB", "BLIVRE"] as const) {
        const title = pick(translation).result.verseTexts.find((v) => v.canonicalId === "PSA_3_0");
        expect(title, `${translation} PSA_3_0`).toBeDefined();
        expect(title?.text.length, translation).toBeGreaterThan(0);
      }

      // At 8:37 (Textus Receptus): existe na KJV e BLIVRE, ausente na WEB (texto crítico).
      const hasAct837 = (name: string): boolean =>
        pick(name).result.verseTexts.some((v) => v.canonicalId === "ACT_8_37");
      expect(hasAct837("KJV")).toBe(true);
      expect(hasAct837("BLIVRE")).toBe(true);
      expect(hasAct837("WEB")).toBe(false);
    });

    it(
      "tie-break 'Hebrew' vs 'Eng-KJV': SÓ as 5 refs de Ester divergem nas 3 Bíblias (âncora da decisão)",
      () => {
        for (const { name, bible, mapper } of built) {
          // (a) As 5 refs de Ester: 'Eng-KJV' NÃO desempata (explode); 'Hebrew' devolve identidade.
          for (const [chapter, verse] of ESTHER_AMBIGUOUS) {
            expect(
              () => mapper.toKjv({ book: "EST", chapter, verse, tradition: "Eng-KJV" }),
              `${name} EST ${chapter}:${verse} sob Eng-KJV deve explodir`,
            ).toThrow(AmbiguousMappingError);
            expect(
              mapper.toKjv({ book: "EST", chapter, verse, tradition: "Hebrew" }),
              `${name} EST ${chapter}:${verse} sob Hebrew deve ser identidade`,
            ).toEqual([{ book: "EST", chapter, verse, subverse: null }]);
          }

          // (b) Varredura exaustiva: as ÚNICAS refs onde 'Eng-KJV' diverge de 'Hebrew'
          // (explode ou resultado diferente) são exatamente essas 5 de Ester — pinado
          // para que uma mudança upstream do TVTMS vire asserção dirigida, não explosão.
          const engThrew: string[] = [];
          const diffs: string[] = [];
          for (const [book, chapters] of bible.books) {
            for (const [ch, chapter] of chapters) {
              const seen = new Set<UsfxVerse>();
              for (const verse of chapter.verses.values()) {
                if (seen.has(verse)) continue;
                seen.add(verse);
                if (verse.text === "") continue;
                const ref = { book, chapter: ch, verse: verse.verse } as const;
                const hebrew = JSON.stringify(mapper.toKjv({ ...ref, tradition: "Hebrew" }));
                let english: string;
                try {
                  english = JSON.stringify(mapper.toKjv({ ...ref, tradition: "Eng-KJV" }));
                } catch (error) {
                  if (error instanceof AmbiguousMappingError) {
                    engThrew.push(`${book} ${ch}:${verse.verse}`);
                    continue;
                  }
                  throw error;
                }
                if (english !== hebrew) diffs.push(`${book} ${ch}:${verse.verse}`);
              }
            }
          }
          const expectedEsther = ESTHER_AMBIGUOUS.map(([c, v]) => `EST ${c}:${v}`).sort();
          expect(engThrew.sort(), `${name}: refs que explodem sob Eng-KJV`).toEqual(expectedEsther);
          expect(diffs, `${name}: diffs Hebrew×Eng-KJV fora de Ester (deve ser vazio)`).toEqual([]);
        }
      },
      60_000,
    );
  },
  60_000,
);

if (!hasAll) {
  it("fontes USFX/TVTMS ausentes — integração PULADA (ver data/sources/manifest.json)", () => {
    expect(hasAll).toBe(false);
  });
}
