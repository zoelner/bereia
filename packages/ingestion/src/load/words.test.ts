import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { USFM_BOOKS, type OriginalWord } from "@bereia/core";
import { editionIncludesTr, parseTagnt, parseTahot } from "../parsers/stepbible/index.js";
import { parseStrongsDict } from "../parsers/strongs/index.js";
import { readOriginalWords, writeOriginalWords } from "./jsonl.js";
import { compareOriginalWord } from "./order.js";
import {
  CANONICAL_STRONG_ID_RE,
  GREEK_OPENSCRIPTURES_MAX,
  assembleOriginalWords,
  buildOriginalWords,
  isExtendedGreekStrongId,
  referencedStrongIds,
  taggedWordToOriginalWord,
  wordBook,
} from "./words.js";
import type { TaggedWordRow } from "../parsers/stepbible/index.js";

/**
 * N6 — build de `original_words` (plano de fechamento da Fase 1 §4/§5).
 *
 * Duas camadas (ADR-008):
 * - UNIT (mock sintético, sempre roda): mapeamento campo-a-campo, forma
 *   canônica do strongId, PK `(canonicalId, position)` única, ordem
 *   determinística via N4, round-trip Zod pelo writer/reader do N4. Nenhum
 *   dado teológico inventado — os mocks são estrutura neutra rotulada.
 * - INTEGRAÇÃO (skipIf, contra `data/sources/` reais): números EXATOS atrelados
 *   ao sha256 do manifest (pula quando a fonte falta — nunca verde falso; rode
 *   com DATA_DIR do repo). Âncoras: ACT_8_37 (23 palavras, todas TR) e PSA_3_0
 *   (6 palavras do título hebraico do Salmo 3).
 */

// --- Mocks sintéticos (estrutura neutra, NÃO conteúdo teológico real) --------

/** Cria uma `TaggedWordRow` mock com defaults neutros; sobrescreva o necessário. */
function mockRow(over: Partial<TaggedWordRow> & Pick<TaggedWordRow, "canonicalId" | "position">): TaggedWordRow {
  return {
    lexeme: "mock",
    strongId: null,
    strongRaw: null,
    morphology: null,
    edition: null,
    ...over,
  };
}

describe("taggedWordToOriginalWord — mapeamento campo-a-campo (mock)", () => {
  it("preserva todos os campos, incluindo o carimbo edition (TAHOT base L)", () => {
    const row = mockRow({
      canonicalId: "GEN_1_1",
      position: 1,
      lexeme: "mock-lexeme",
      strongId: "H7225",
      strongRaw: "H9003/{H7225G}",
      morphology: "HNcbsa",
      edition: "L",
    });
    expect(taggedWordToOriginalWord(row)).toStrictEqual({
      canonicalId: "GEN_1_1",
      position: 1,
      lexeme: "mock-lexeme",
      strongId: "H7225",
      strongRaw: "H9003/{H7225G}",
      morphology: "HNcbsa",
      edition: "L",
    });
  });

  it("preserva o carimbo WordType cru do TAGNT (ex.: NKO) e strongId null", () => {
    const row = mockRow({ canonicalId: "MAT_1_1", position: 3, strongId: null, edition: "NKO" });
    const word = taggedWordToOriginalWord(row);
    expect(word.edition).toBe("NKO");
    expect(word.strongId).toBeNull();
  });

  it("EXPLODE em strongId fora da forma canônica /^[HG]\\d{4}$/ (FK estrutural)", () => {
    expect(() => taggedWordToOriginalWord(mockRow({ canonicalId: "GEN_1_1", position: 1, strongId: "H1" }))).toThrow(
      /forma canônica/,
    );
    expect(() =>
      taggedWordToOriginalWord(mockRow({ canonicalId: "GEN_1_1", position: 1, strongId: "G12345" })),
    ).toThrow(/forma canônica/);
  });

  it("aceita strongId grego estendido de 4 díg. (G6053) — a existência é FK de dado, não estrutural", () => {
    const word = taggedWordToOriginalWord(mockRow({ canonicalId: "MAT_2_16", position: 29, strongId: "G6053" }));
    expect(word.strongId).toBe("G6053");
    expect(isExtendedGreekStrongId("G6053")).toBe(true);
  });
});

describe("isExtendedGreekStrongId — léxico STEPBible além do openscriptures", () => {
  it("grego > 5624 é estendido; grego <= 5624, hebraico e null-shape não", () => {
    expect(GREEK_OPENSCRIPTURES_MAX).toBe(5624);
    expect(isExtendedGreekStrongId("G6053")).toBe(true);
    expect(isExtendedGreekStrongId("G7530")).toBe(true);
    expect(isExtendedGreekStrongId("G5624")).toBe(false);
    expect(isExtendedGreekStrongId("G0976")).toBe(false);
    expect(isExtendedGreekStrongId("H8674")).toBe(false);
  });
});

describe("assembleOriginalWords — PK única e ordem determinística (mock)", () => {
  it("EXPLODE em (canonicalId, position) duplicado no conjunto combinado", () => {
    const rows = [
      mockRow({ canonicalId: "GEN_1_1", position: 1 }),
      mockRow({ canonicalId: "GEN_1_1", position: 1 }),
    ];
    expect(() => assembleOriginalWords(rows)).toThrow(/duplicada/);
  });

  it("AT e NT com o MESMO position não colidem (livros distintos)", () => {
    const words = assembleOriginalWords([
      mockRow({ canonicalId: "GEN_1_1", position: 1 }),
      mockRow({ canonicalId: "MAT_1_1", position: 1 }),
    ]);
    expect(words).toHaveLength(2);
  });

  it("ordena por (livro do cânon → capítulo → verso → position), independente da entrada", () => {
    const rows: TaggedWordRow[] = [
      mockRow({ canonicalId: "MAT_1_1", position: 2 }),
      mockRow({ canonicalId: "GEN_1_2", position: 1 }),
      mockRow({ canonicalId: "MAT_1_1", position: 1 }),
      mockRow({ canonicalId: "GEN_1_1", position: 2 }),
      mockRow({ canonicalId: "GEN_1_1", position: 1 }),
    ];
    const order = assembleOriginalWords(rows).map((w) => `${w.canonicalId}#${String(w.position)}`);
    expect(order).toEqual(["GEN_1_1#1", "GEN_1_1#2", "GEN_1_2#1", "MAT_1_1#1", "MAT_1_1#2"]);
  });

  it("saída fica estritamente ordenada por compareOriginalWord (chaves únicas)", () => {
    const words = assembleOriginalWords([
      mockRow({ canonicalId: "MAT_1_1", position: 2 }),
      mockRow({ canonicalId: "GEN_1_1", position: 1 }),
      mockRow({ canonicalId: "MAT_1_1", position: 1 }),
    ]);
    for (let i = 0; i + 1 < words.length; i += 1) {
      expect(compareOriginalWord(words[i] as OriginalWord, words[i + 1] as OriginalWord)).toBeLessThan(0);
    }
  });
});

describe("referencedStrongIds — só não-nulos, semântica de conjunto (mock)", () => {
  it("coleta os strongId não-nulos distintos, ignora null", () => {
    const words = assembleOriginalWords([
      mockRow({ canonicalId: "GEN_1_1", position: 1, strongId: "H7225" }),
      mockRow({ canonicalId: "GEN_1_1", position: 2, strongId: "H0430" }),
      mockRow({ canonicalId: "GEN_1_1", position: 3, strongId: "H7225" }),
      mockRow({ canonicalId: "GEN_1_1", position: 4, strongId: null }),
    ]);
    expect(referencedStrongIds(words)).toEqual(new Set(["H7225", "H0430"]));
  });
});

describe("round-trip pelo writer/reader do N4 (mock)", () => {
  it("writeOriginalWords → readOriginalWords devolve o mesmo conjunto (Zod)", () => {
    const words = assembleOriginalWords([
      mockRow({ canonicalId: "GEN_1_1", position: 1, strongId: "H7225", morphology: "HNcbsa", edition: "L" }),
      mockRow({ canonicalId: "MAT_1_1", position: 1, strongId: "G0976", edition: "NKO" }),
    ]);
    expect(readOriginalWords(writeOriginalWords(words))).toStrictEqual(words);
  });
});

// --- Integração contra as fontes reais (skipIf; nunca verde falso) -----------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const TAHOT_FILES = ["TAHOT_Gen-Deu.txt", "TAHOT_Jos-Est.txt", "TAHOT_Job-Sng.txt", "TAHOT_Isa-Mal.txt"] as const;
const TAGNT_FILES = ["TAGNT_Mat-Jhn.txt", "TAGNT_Act-Rev.txt"] as const;
const STRONGS_HEBREW = "StrongHebrewG.xml";
const STRONGS_GREEK = "strongsgreek.xml";

const tahotPath = (f: string): string => path.join(dataDir, "sources", "stepbible-tahot", f);
const tagntPath = (f: string): string => path.join(dataDir, "sources", "stepbible-tagnt", f);
const strongsPath = (f: string): string => path.join(dataDir, "sources", "strongs", f);
const manifestPath = path.join(dataDir, "sources", "manifest.json");

const requiredFiles = [
  ...TAHOT_FILES.map(tahotPath),
  ...TAGNT_FILES.map(tagntPath),
  strongsPath(STRONGS_HEBREW),
  strongsPath(STRONGS_GREEK),
  manifestPath,
];
const hasAll = requiredFiles.every((f) => existsSync(f));

/**
 * Números EXATOS atrelados ao sha256 do manifest (TAHOT/TAGNT commit
 * 0f60797…; strongs commit 0acd2f2…). Drift de fonte deve acusar no guarda de
 * sha256 ANTES destas asserções (ADR-008).
 */
const TAHOT_PRODUCED = 305638;
const TAGNT_PRODUCED = 142096;
const TOTAL_PRODUCED = TAHOT_PRODUCED + TAGNT_PRODUCED; // 447.734

/**
 * Léxicos STEPBible estendidos (grego > 5624) referenciados mas SEM entrada no
 * dicionário openscriptures — categoria OQ-7 manifestada em 4 díg. (G6xxx/G7xxx).
 * Baseline CONGELADO ao manifest: 71 lexemas distintos em 363 palavras. Qualquer
 * mudança = drift de fonte (falha ruidosa). Fora isso, a FK é limpa (0 órfão).
 */
const EXTENDED_GREEK_LEXEMES = 71;
const EXTENDED_GREEK_WORDS = 363;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface Manifest {
  sources: Record<string, { files?: Record<string, string> }>;
}

/** sha256 esperado de um arquivo, lido do manifest (chave = caminho relativo a `sources/`). */
function expectedSha(source: string, relFromSources: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const sha = manifest.sources[source]?.files?.[relFromSources];
  if (sha === undefined) {
    throw new Error(`manifest sem sha256 para ${source} → ${relFromSources}`);
  }
  return sha;
}

/** Cache do build real (parse de ~95 MB roda uma única vez para todas as its). */
let cache:
  | {
      tahotCount: number;
      tagntCount: number;
      words: OriginalWord[];
      dictIds: Set<string>;
    }
  | undefined;

function real(): NonNullable<typeof cache> {
  if (cache === undefined) {
    const tahotTsvs = TAHOT_FILES.map((f) => readFileSync(tahotPath(f), "utf8"));
    const tagntTsvs = TAGNT_FILES.map((f) => readFileSync(tagntPath(f), "utf8"));
    const tahotCount = tahotTsvs.reduce((n, tsv) => n + parseTahot(tsv).length, 0);
    const tagntCount = tagntTsvs.reduce((n, tsv) => n + parseTagnt(tsv).length, 0);
    const words = buildOriginalWords({ tahot: tahotTsvs, tagnt: tagntTsvs });
    const dict = parseStrongsDict({
      hebrewXml: readFileSync(strongsPath(STRONGS_HEBREW), "utf8"),
      greekXml: readFileSync(strongsPath(STRONGS_GREEK), "utf8"),
    });
    cache = { tahotCount, tagntCount, words, dictIds: new Set(dict.map((e) => e.id)) };
  }
  return cache;
}

describe.skipIf(!hasAll)("N6 integração — original_words a partir das fontes reais", () => {
  // Aquece o cache (parse de ~95 MB) uma única vez, com folga de tempo — as its
  // reusam o resultado e ficam rápidas (o default de 5 s do Vitest não cobre o parse).
  beforeAll(() => {
    real();
  }, 180000);

  it("as fontes casam o sha256 pinado no manifest (ADR-008)", () => {
    for (const f of TAHOT_FILES) {
      expect(sha256(tahotPath(f))).toBe(expectedSha("stepbible-tahot", `stepbible-tahot/${f}`));
    }
    for (const f of TAGNT_FILES) {
      expect(sha256(tagntPath(f))).toBe(expectedSha("stepbible-tagnt", `stepbible-tagnt/${f}`));
    }
    expect(sha256(strongsPath(STRONGS_HEBREW))).toBe(expectedSha("strongs", `strongs/${STRONGS_HEBREW}`));
    expect(sha256(strongsPath(STRONGS_GREEK))).toBe(expectedSha("strongs", `strongs/${STRONGS_GREEK}`));
  });

  it("contagens EXATAS: TAHOT 305.638 + TAGNT 142.096 = 447.734 palavras", () => {
    const { tahotCount, tagntCount, words } = real();
    expect(tahotCount).toBe(TAHOT_PRODUCED);
    expect(tagntCount).toBe(TAGNT_PRODUCED);
    expect(words).toHaveLength(TOTAL_PRODUCED);
  });

  it("PK (canonicalId, position) única no conjunto combinado AT+NT", () => {
    const { words } = real();
    const keys = new Set(words.map((w) => `${w.canonicalId}#${String(w.position)}`));
    expect(keys.size).toBe(words.length);
  });

  it("todo strongId não-nulo casa a forma canônica /^[HG]\\d{4}$/", () => {
    const { words } = real();
    const bad = words.filter((w) => w.strongId !== null && !CANONICAL_STRONG_ID_RE.test(w.strongId));
    expect(bad).toHaveLength(0);
  });

  it("FK contra strongs.jsonl (N1): 0 órfão fora do léxico estendido (71 lexemas / 363 palavras)", () => {
    const { words, dictIds } = real();
    const referenced = referencedStrongIds(words);
    const unresolved = [...referenced].filter((id) => !dictIds.has(id));
    // Todo id não-resolvido DEVE ser um estendido grego conhecido (categoria OQ-7).
    const orphan = unresolved.filter((id) => !isExtendedGreekStrongId(id));
    expect(orphan).toEqual([]);
    expect(unresolved).toHaveLength(EXTENDED_GREEK_LEXEMES);
    const extendedWordCount = words.filter(
      (w) => w.strongId !== null && isExtendedGreekStrongId(w.strongId) && !dictIds.has(w.strongId),
    ).length;
    expect(extendedWordCount).toBe(EXTENDED_GREEK_WORDS);
    // O restante (não-estendido) resolve 100% no dicionário.
    const resolved = [...referenced].filter((id) => !isExtendedGreekStrongId(id));
    expect(resolved.every((id) => dictIds.has(id))).toBe(true);
  });

  it("0 deuterocanônico: todo livro pertence ao cânon de 66 (USFM_BOOKS)", () => {
    const { words } = real();
    const canon = new Set<string>(USFM_BOOKS);
    const books = new Set(words.map((w) => wordBook(w)));
    expect([...books].every((b) => canon.has(b))).toBe(true);
    expect(books.size).toBe(USFM_BOOKS.length); // TAHOT+TAGNT cobrem os 66 livros
  });

  it("ordem determinística: estritamente crescente por compareOriginalWord", () => {
    const { words } = real();
    for (let i = 0; i + 1 < words.length; i += 1) {
      expect(compareOriginalWord(words[i] as OriginalWord, words[i + 1] as OriginalWord)).toBeLessThan(0);
    }
  });

  it("âncora ACT_8_37: 23 palavras, TODAS presentes no Textus Receptus (K ∈ WordType)", () => {
    const { words } = real();
    const act837 = words.filter((w) => w.canonicalId === "ACT_8_37");
    expect(act837).toHaveLength(23);
    expect(act837.every((w) => w.edition !== null && editionIncludesTr(w.edition))).toBe(true);
  });

  it("âncora PSA_3_0: 6 palavras do título hebraico (verso 0), carimbo base L", () => {
    const { words } = real();
    const psa30 = words.filter((w) => w.canonicalId === "PSA_3_0");
    expect(psa30).toHaveLength(6);
    expect(psa30.every((w) => w.edition === "L")).toBe(true);
    // posições densas 1..6 na ordem de leitura do título
    expect(psa30.map((w) => w.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
