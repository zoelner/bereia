import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { CanonicalVerse, Edge, OriginalWord, StrongsEntry, VerseText } from "@bereia/core";
import {
  writeCanonicalVerses,
  writeEdges,
  writeOriginalWords,
  writeStrongsEntries,
  writeVerseTexts,
} from "./jsonl.js";
import { EXPECTED_EMBEDDING_MODEL_STAMP, EXPECTED_HF_REVISION, writeEmbeddingRows, type EmbeddingRow } from "./embed.js";
import {
  crossCheckIntegrity,
  loadEmbeddings,
  loadPostgres,
  readCanonicalData,
  resolveEmbeddingsFile,
  type CanonicalData,
} from "./postgres.js";

/**
 * Ancorado em requisito (ADR-008/plano §3.5/§5 linha N10):
 * - UNIT (sempre roda, sem rede): `crossCheckIntegrity`/`loadEmbeddings` contra
 *   fixtures SINTÉTICAS pequenas (mock, nada teológico inventado).
 * - INTEGRAÇÃO (skipIf sem Postgres acessível — nunca verde falso): banco de
 *   teste efêmero criado/destruído por suíte (`CREATE DATABASE`/`DROP
 *   DATABASE`), isolado do banco de desenvolvimento e de outras execuções
 *   concorrentes; prova (a) projeção idempotente, (b) FK íntegra, (c)
 *   canonStatus/authorizedLevels corretos, (d) embedding joinado/NULL, (e)
 *   derivado órfão/carimbo errado explode.
 */

// --- fixtures sintéticas (mock, marcadas — nunca dado teológico real) ------

function mockVerse(id: string, over: Partial<CanonicalVerse> = {}): CanonicalVerse {
  const [book, chapter, verse] = id.split("_");
  return {
    id,
    book: book as CanonicalVerse["book"],
    chapter: Number(chapter),
    verse: Number(verse),
    canonStatus: "protestant",
    theologicalCategory: null,
    ...over,
  };
}

function mockVerseText(canonicalId: string, translation: string, over: Partial<VerseText> = {}): VerseText {
  return {
    canonicalId,
    translation,
    text: `mock texto placeholder ${canonicalId}/${translation}`,
    embeddingModel: null,
    thematicTags: [],
    culturalContext: null,
    humanReviewed: false,
    reviewedBy: null,
    authorizedLevels: ["public"],
    ...over,
  };
}

function mockWord(canonicalId: string, position: number, over: Partial<OriginalWord> = {}): OriginalWord {
  return {
    canonicalId,
    position,
    lexeme: "מוֹק",
    strongId: null,
    strongRaw: null,
    morphology: null,
    edition: null,
    ...over,
  };
}

function mockStrong(id: string, over: Partial<StrongsEntry> = {}): StrongsEntry {
  return {
    id,
    language: id.startsWith("H") ? "hebrew" : "greek",
    lemma: "מוֹק",
    transliteration: "mock",
    definition: "definição placeholder mock",
    ...over,
  };
}

function mockEdge(sourceId: string, targetId: string): Edge {
  return { sourceId, targetId, kind: "tsk" };
}

const MOCK_VERSES: CanonicalVerse[] = [mockVerse("GEN_1_1"), mockVerse("GEN_1_2"), mockVerse("EXO_1_1")];
const MOCK_VERSE_TEXTS: VerseText[] = [
  mockVerseText("GEN_1_1", "KJV"),
  mockVerseText("GEN_1_2", "KJV"),
  mockVerseText("EXO_1_1", "KJV"),
];
const MOCK_STRONGS: StrongsEntry[] = [mockStrong("H0001"), mockStrong("H0002")];
const MOCK_WORDS: OriginalWord[] = [
  mockWord("GEN_1_1", 0, { strongId: "H0001" }),
  mockWord("GEN_1_2", 0, { strongId: "H0002" }),
];
const MOCK_EDGES: Edge[] = [mockEdge("GEN_1_1", "EXO_1_1")];

// --- helpers de fixture em disco --------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface WriteCanonicalFixtureOptions {
  verses?: readonly CanonicalVerse[];
  verseTexts?: readonly VerseText[];
  words?: readonly OriginalWord[];
  strongsEntries?: readonly StrongsEntry[];
  edges?: readonly Edge[];
}

/** Grava o JSONL canônico (layout OQ-1) num diretório temporário — reusa os writers do N4. */
function writeCanonicalFixture(canonicalDir: string, options: WriteCanonicalFixtureOptions = {}): void {
  const verses = options.verses ?? MOCK_VERSES;
  const verseTexts = options.verseTexts ?? MOCK_VERSE_TEXTS;
  const words = options.words ?? MOCK_WORDS;
  const strongsEntries = options.strongsEntries ?? MOCK_STRONGS;
  const edges = options.edges ?? MOCK_EDGES;

  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(path.join(canonicalDir, "canonical_verses.jsonl"), writeCanonicalVerses(verses));
  writeFileSync(path.join(canonicalDir, "strongs.jsonl"), writeStrongsEntries(strongsEntries));
  writeFileSync(path.join(canonicalDir, "edges.jsonl"), writeEdges(edges));

  const verseTextsDir = path.join(canonicalDir, "verse_texts");
  mkdirSync(verseTextsDir, { recursive: true });
  const verseTextsByBook = new Map<string, VerseText[]>();
  for (const record of verseTexts) {
    const book = record.canonicalId.split("_")[0] as string;
    const forBook = verseTextsByBook.get(book) ?? [];
    forBook.push(record);
    verseTextsByBook.set(book, forBook);
  }
  for (const [book, records] of verseTextsByBook) {
    writeFileSync(path.join(verseTextsDir, `${book}.jsonl`), writeVerseTexts(records));
  }

  const wordsDir = path.join(canonicalDir, "original_words");
  mkdirSync(wordsDir, { recursive: true });
  const wordsByBook = new Map<string, OriginalWord[]>();
  for (const record of words) {
    const book = record.canonicalId.split("_")[0] as string;
    const forBook = wordsByBook.get(book) ?? [];
    forBook.push(record);
    wordsByBook.set(book, forBook);
  }
  for (const [book, records] of wordsByBook) {
    writeFileSync(path.join(wordsDir, `${book}.jsonl`), writeOriginalWords(records));
  }
}

/** Vetor mock com exatamente 1024 dimensões — a coluna `vector(1024)` do schema exige o tamanho exato. */
function mockEmbeddingVector(): number[] {
  return Array.from({ length: 1024 }, (_, index) => Number(((index % 100) / 100).toFixed(4)));
}

function mockEmbeddingRow(canonicalId: string, translation: string, over: Partial<EmbeddingRow> = {}): EmbeddingRow {
  return {
    canonicalId,
    translation,
    embedding: mockEmbeddingVector(),
    embeddingModel: EXPECTED_EMBEDDING_MODEL_STAMP,
    ...over,
  };
}

// --- unit: crossCheckIntegrity ----------------------------------------------

describe("crossCheckIntegrity — unit (fixture sintética)", () => {
  function data(over: Partial<CanonicalData> = {}): CanonicalData {
    return {
      canonicalVerses: MOCK_VERSES,
      verseTexts: MOCK_VERSE_TEXTS,
      originalWords: MOCK_WORDS,
      strongsEntries: MOCK_STRONGS,
      edges: MOCK_EDGES,
      ...over,
    };
  }

  it("não explode com o fixture consistente", () => {
    expect(() => crossCheckIntegrity(data())).not.toThrow();
  });

  it("explode quando verse_texts.canonical_id não existe em canonical_verses", () => {
    expect(() =>
      crossCheckIntegrity(data({ verseTexts: [...MOCK_VERSE_TEXTS, mockVerseText("MAT_1_1", "KJV")] })),
    ).toThrow(/verse_texts\.canonical_id/);
  });

  it("explode quando original_words.strong_id não existe em strongs (não é FK real do schema)", () => {
    expect(() =>
      crossCheckIntegrity(data({ originalWords: [...MOCK_WORDS, mockWord("GEN_1_1", 1, { strongId: "H9999" })] })),
    ).toThrow(/original_words\.strong_id/);
  });

  it("explode quando edges.source_id/target_id não existe em canonical_verses", () => {
    expect(() => crossCheckIntegrity(data({ edges: [...MOCK_EDGES, mockEdge("GEN_1_1", "MAT_1_1")] }))).toThrow(
      /edges\.source_id\/target_id/,
    );
  });

  it("explode quando original_words.canonical_id não existe em canonical_verses", () => {
    expect(() =>
      crossCheckIntegrity(data({ originalWords: [...MOCK_WORDS, mockWord("MAT_1_1", 0)] })),
    ).toThrow(/original_words\.canonical_id/);
  });
});

// --- unit: readCanonicalData -------------------------------------------------

describe("readCanonicalData — unit (fixture sintética em disco)", () => {
  it("lê as 5 tabelas do layout OQ-1 e revalida via Zod", () => {
    const canonicalDir = makeTmpDir("bereia-n10-read-");
    writeCanonicalFixture(canonicalDir);
    const data = readCanonicalData(canonicalDir);
    expect(data.canonicalVerses).toHaveLength(3);
    expect(data.verseTexts).toHaveLength(3);
    expect(data.originalWords).toHaveLength(2);
    expect(data.strongsEntries).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
  });

  it("explode quando canonical_verses.jsonl está ausente", () => {
    const canonicalDir = makeTmpDir("bereia-n10-read-missing-");
    mkdirSync(canonicalDir, { recursive: true });
    expect(() => readCanonicalData(canonicalDir)).toThrow(/canonical_verses\.jsonl/);
  });
});

// --- unit: resolveEmbeddingsFile / loadEmbeddings ---------------------------

describe("resolveEmbeddingsFile — unit", () => {
  it("default: data/derived/embeddings-{EXPECTED_HF_REVISION}.jsonl", () => {
    expect(resolveEmbeddingsFile("/tmp/data", undefined)).toBe(
      path.join("/tmp/data", "derived", `embeddings-${EXPECTED_HF_REVISION}.jsonl`),
    );
  });

  it("caminho explícito tem prioridade sobre o default", () => {
    expect(resolveEmbeddingsFile("/tmp/data", "/tmp/custom.jsonl")).toBe("/tmp/custom.jsonl");
  });
});

describe("loadEmbeddings — unit (fixture sintética)", () => {
  it("arquivo ausente → null (embedding fica NULL) + aviso claro", () => {
    const dataDir = makeTmpDir("bereia-n10-embed-missing-");
    const warnings: string[] = [];
    const result = loadEmbeddings(path.join(dataDir, "inexistente.jsonl"), MOCK_VERSE_TEXTS, (m) =>
      warnings.push(m),
    );
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/embedding.*NULL|NULL.*embedding/i);
  });

  it("join completo (todo verse_text tem embedding correspondente) → Map com todas as chaves", () => {
    const dataDir = makeTmpDir("bereia-n10-embed-ok-");
    const filePath = path.join(dataDir, "embeddings.jsonl");
    writeFileSync(
      filePath,
      writeEmbeddingRows(MOCK_VERSE_TEXTS.map((vt) => mockEmbeddingRow(vt.canonicalId, vt.translation))),
    );
    const result = loadEmbeddings(filePath, MOCK_VERSE_TEXTS, () => {
      throw new Error("não deveria avisar");
    });
    expect(result).not.toBeNull();
    expect(result?.size).toBe(MOCK_VERSE_TEXTS.length);
  });

  it("explode quando há linha derivada órfã (sem verse_text correspondente)", () => {
    const dataDir = makeTmpDir("bereia-n10-embed-orphan-");
    const filePath = path.join(dataDir, "embeddings.jsonl");
    writeFileSync(
      filePath,
      writeEmbeddingRows([
        ...MOCK_VERSE_TEXTS.map((vt) => mockEmbeddingRow(vt.canonicalId, vt.translation)),
        mockEmbeddingRow("MAT_1_1", "KJV"),
      ]),
    );
    expect(() => loadEmbeddings(filePath, MOCK_VERSE_TEXTS, () => undefined)).toThrow(/não correspondem a nenhum verse_texts/);
  });

  it("explode quando o join é incompleto (verse_text sem embedding correspondente)", () => {
    const dataDir = makeTmpDir("bereia-n10-embed-partial-");
    const filePath = path.join(dataDir, "embeddings.jsonl");
    const [first] = MOCK_VERSE_TEXTS;
    writeFileSync(filePath, writeEmbeddingRows([mockEmbeddingRow(first!.canonicalId, first!.translation)]));
    expect(() => loadEmbeddings(filePath, MOCK_VERSE_TEXTS, () => undefined)).toThrow(/join precisa ser completo/);
  });

  it("explode quando embeddingModel diverge do carimbo esperado (OQ-8)", () => {
    const dataDir = makeTmpDir("bereia-n10-embed-badmodel-");
    const filePath = path.join(dataDir, "embeddings.jsonl");
    writeFileSync(
      filePath,
      writeEmbeddingRows(
        MOCK_VERSE_TEXTS.map((vt) =>
          mockEmbeddingRow(vt.canonicalId, vt.translation, { embeddingModel: "outro/modelo@revisao-errada" }),
        ),
      ),
    );
    expect(() => loadEmbeddings(filePath, MOCK_VERSE_TEXTS, () => undefined)).toThrow(/embeddingModel divergente/);
  });
});

// --- integração real — Postgres (skipIf inacessível, banco de teste efêmero)

/** Sonda conectividade real — nunca verde falso (ADR-006/008). */
async function probeDatabaseUp(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://bereia:bereia@localhost:5432/bereia";
const databaseUp = await probeDatabaseUp(ADMIN_DATABASE_URL);

describe.skipIf(!databaseUp)("integração real — load Postgres (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let verifier: ReturnType<typeof postgres>;

  beforeAll(async () => {
    testDbName = `bereia_test_n10_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE "${testDbName}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/${testDbName}`;
    testDatabaseUrl = url.toString();
    verifier = postgres(testDatabaseUrl, { max: 1 });
  }, 30_000);

  afterAll(async () => {
    await verifier.end();
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 30_000);

  it(
    "carrega o fixture sintético: contagens, FK íntegra, hard filter (canonStatus/authorizedLevels) corretos",
    { timeout: 30_000 },
    async () => {
      const dataDir = makeTmpDir("bereia-n10-int-basic-");
      const canonicalDir = path.join(dataDir, "canonical");
      writeCanonicalFixture(canonicalDir);

      const result = await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });

      expect(result.counts).toEqual({
        canonicalVerses: 3,
        verseTexts: 3,
        strongs: 2,
        originalWords: 2,
        edges: 1,
      });
      expect(result.embeddingsJoined).toBe(false);

      const verses = await verifier<{ id: string; canon_status: string }[]>`
        SELECT id, canon_status FROM canonical_verses ORDER BY id
      `;
      expect(verses.map((v) => v.id)).toEqual(["EXO_1_1", "GEN_1_1", "GEN_1_2"]);
      expect(verses.every((v) => v.canon_status === "protestant")).toBe(true);

      const verseTexts = await verifier<{ canonical_id: string; authorized_levels: string[]; embedding: null }[]>`
        SELECT canonical_id, authorized_levels, embedding FROM verse_texts ORDER BY canonical_id
      `;
      expect(verseTexts).toHaveLength(3);
      expect(verseTexts.every((vt) => vt.authorized_levels.length === 1 && vt.authorized_levels[0] === "public")).toBe(
        true,
      );
      expect(verseTexts.every((vt) => vt.embedding === null)).toBe(true);

      const wordsWithStrongs = await verifier<{ canonical_id: string; strong_id: string | null }[]>`
        SELECT canonical_id, strong_id FROM original_words ORDER BY canonical_id
      `;
      expect(wordsWithStrongs.map((w) => w.strong_id).sort()).toEqual(["H0001", "H0002"]);

      const edges = await verifier<{ source_id: string; target_id: string; kind: string }[]>`
        SELECT source_id, target_id, kind FROM edges
      `;
      expect(edges).toEqual([{ source_id: "GEN_1_1", target_id: "EXO_1_1", kind: "tsk" }]);
    },
  );

  it(
    "idempotente: dois loads seguidos convergem para o mesmo estado (contagens e amostra estável)",
    { timeout: 30_000 },
    async () => {
      const dataDir = makeTmpDir("bereia-n10-int-idem-");
      const canonicalDir = path.join(dataDir, "canonical");
      writeCanonicalFixture(canonicalDir);

      const first = await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });
      const second = await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });

      expect(second.counts).toEqual(first.counts);

      const verses = await verifier<{ id: string }[]>`SELECT id FROM canonical_verses ORDER BY id`;
      expect(verses.map((v) => v.id)).toEqual(["EXO_1_1", "GEN_1_1", "GEN_1_2"]);

      const countRows = await verifier<{ count: string }[]>`SELECT count(*) FROM canonical_verses`;
      expect(Number(countRows[0]?.count)).toBe(3);
    },
  );

  it(
    "join do embedding: embedding preenchido quando o derivado existe (formato pgvector correto)",
    { timeout: 30_000 },
    async () => {
      const dataDir = makeTmpDir("bereia-n10-int-embed-");
      const canonicalDir = path.join(dataDir, "canonical");
      writeCanonicalFixture(canonicalDir);

      const embeddingsFile = path.join(dataDir, "derived", `embeddings-${EXPECTED_HF_REVISION}.jsonl`);
      mkdirSync(path.dirname(embeddingsFile), { recursive: true });
      writeFileSync(
        embeddingsFile,
        writeEmbeddingRows(MOCK_VERSE_TEXTS.map((vt) => mockEmbeddingRow(vt.canonicalId, vt.translation))),
      );

      const result = await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });
      expect(result.embeddingsJoined).toBe(true);

      const rows = await verifier<{ canonical_id: string; embedding: string; embedding_model: string }[]>`
        SELECT canonical_id, embedding::text, embedding_model FROM verse_texts ORDER BY canonical_id
      `;
      expect(rows).toHaveLength(3);
      const expectedVector = mockEmbeddingVector();
      for (const row of rows) {
        const parsed = JSON.parse(row.embedding) as number[];
        expect(parsed).toHaveLength(1024);
        expect(parsed).toEqual(expectedVector);
        expect(row.embedding_model).toBe(EXPECTED_EMBEDDING_MODEL_STAMP);
      }
    },
  );

  it("explode quando o derivado tem linha órfã (não chega a tocar o banco)", { timeout: 30_000 }, async () => {
    const dataDir = makeTmpDir("bereia-n10-int-orphan-");
    const canonicalDir = path.join(dataDir, "canonical");
    writeCanonicalFixture(canonicalDir);

    const embeddingsFile = path.join(dataDir, "derived", `embeddings-${EXPECTED_HF_REVISION}.jsonl`);
    mkdirSync(path.dirname(embeddingsFile), { recursive: true });
    writeFileSync(
      embeddingsFile,
      writeEmbeddingRows([
        ...MOCK_VERSE_TEXTS.map((vt) => mockEmbeddingRow(vt.canonicalId, vt.translation)),
        mockEmbeddingRow("MAT_1_1", "KJV"),
      ]),
    );

    await expect(loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl })).rejects.toThrow(/não correspondem a nenhum verse_texts/);
  });

  it("explode quando a integridade referencial do JSONL está quebrada (não chega a tocar o banco)", async () => {
    const dataDir = makeTmpDir("bereia-n10-int-badfk-");
    const canonicalDir = path.join(dataDir, "canonical");
    writeCanonicalFixture(canonicalDir, { edges: [...MOCK_EDGES, mockEdge("GEN_1_1", "MAT_1_1")] });

    await expect(loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl })).rejects.toThrow(
      /integridade referencial/,
    );
  });

  it("migrations aplicadas de forma idempotente: schema correto após dois loads seguidos", { timeout: 30_000 }, async () => {
    const dataDir = makeTmpDir("bereia-n10-int-migrations-");
    const canonicalDir = path.join(dataDir, "canonical");
    writeCanonicalFixture(canonicalDir);

    await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });
    await loadPostgres({ dataDir, canonicalDir, databaseUrl: testDatabaseUrl });

    const editionColumn = await verifier<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'original_words' AND column_name = 'edition'
    `;
    expect(editionColumn).toHaveLength(1);
  });
});
