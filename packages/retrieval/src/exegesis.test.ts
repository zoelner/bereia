import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { CanonicalId } from "@bereia/core";
import { getExegesis } from "./exegesis.js";

/**
 * Ancorado no comando de aceite do N4 (plano §7, linha N4): `skipIf(!DATABASE_URL)`
 * — verso inexistente → null; `originalWords` traz join de `strongs` (e
 * `strongId=null` preservado); `interpretations` divergentes vêm separadas;
 * hard filter aplicado. Padrão N10 (`ingestion/load/postgres.test.ts`): banco
 * de teste EFÊMERO (CREATE/DROP DATABASE, nome único) com migrations reais e
 * fixtures SINTÉTICAS marcadas como mock — zero conteúdo teológico real.
 */

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

/** Sonda se o dado real de `bereia-data` está carregado (via `load:postgres`) — GEN_1_1 é uma âncora estável. */
async function probeRealDataLoaded(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    const rows = await sql<{ id: string }[]>`SELECT id FROM canonical_verses WHERE id = 'GEN_1_1'`;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://bereia:bereia@localhost:5432/bereia";
const databaseUp = await probeDatabaseUp(ADMIN_DATABASE_URL);
const realDataLoaded = databaseUp && (await probeRealDataLoaded(ADMIN_DATABASE_URL));

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/drizzle");

function readMigration(fileName: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

describe.skipIf(!databaseUp)("getExegesis — integração real (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    testDbName = `bereia_test_n4_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE "${testDbName}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/${testDbName}`;
    testDatabaseUrl = url.toString();
    sql = postgres(testDatabaseUrl, { max: 4 });

    await sql.begin((tx) => tx.unsafe(readMigration("0000_init.sql")));
    await sql.begin((tx) => tx.unsafe(readMigration("0001_original_words_edition.sql")));

    // --- fixture sintética (mock, marcada — nunca dado teológico real) -----
    // `OBA_1_2` é sintético com `canon_status='deuterocanonical'` só para exercitar o hard filter —
    // `canonicalIdSchema` (core/canon.ts) restringe o vocabulário de livros aos 66 do cânon protestante,
    // então nenhum dado real jamais teria essa combinação; aqui é puramente a prova do filtro no SQL.
    await sql`
      INSERT INTO canonical_verses (id, book, chapter, verse, canon_status, theological_category)
      VALUES
        ('OBA_1_1', 'OBA', 1, 1, 'protestant', NULL),
        ('OBA_1_2', 'OBA', 1, 2, 'deuterocanonical', NULL),
        ('OBA_1_3', 'OBA', 1, 3, 'protestant', NULL)
    `;

    await sql`
      INSERT INTO verse_texts
        (canonical_id, translation, text, embedding_model, thematic_tags, cultural_context,
         human_reviewed, reviewed_by, authorized_levels)
      VALUES
        ('OBA_1_1', 'mock-a', 'texto sintético de mock A, sem valor teológico', NULL, '{}', NULL, false, NULL, '{public}'),
        ('OBA_1_1', 'mock-b', 'texto sintético de mock B, restrito', NULL, '{}', NULL, false, NULL, '{curated}')
    `;

    await sql`
      INSERT INTO strongs (id, language, lemma, transliteration, definition)
      VALUES ('H0001', 'hebrew', 'מוֹק', 'mock', 'definição sintética de mock')
    `;

    await sql`
      INSERT INTO original_words (canonical_id, position, lexeme, strong_id, strong_raw, morphology, edition)
      VALUES
        ('OBA_1_1', 0, 'mock-lexeme-resolvido', 'H0001', 'H0001', NULL, NULL),
        ('OBA_1_1', 1, 'mock-lexeme-estendido', NULL, 'H90001', NULL, NULL)
    `;

    await sql`
      INSERT INTO interpretations (canonical_id, view_label, text, tradition, source, human_reviewed, reviewed_by)
      VALUES
        ('OBA_1_1', 'mock-visao-a', 'visão sintética A, sem valor teológico', NULL, NULL, false, NULL),
        ('OBA_1_1', 'mock-visao-b', 'visão sintética B, divergente de A, sem valor teológico', NULL, NULL, false, NULL)
    `;

    // 11 interpretations sintéticas em OBA_1_3, dedicadas a provar ordenação NUMÉRICA de
    // `interpretations.id` (serial). Como a sequência do `id` é compartilhada pela tabela
    // inteira, e OBA_1_1 já inseriu 2 linhas acima, estas caem em ids que atravessam a casa
    // das dezenas (ex.: 3..13) — suficiente para distinguir ordenação numérica (2,3,...,13)
    // de lexicográfica sobre `id::text` (que colocaria "10","11","12","13" antes de "3").
    await sql`
      INSERT INTO interpretations (canonical_id, view_label, text, tradition, source, human_reviewed, reviewed_by)
      SELECT
        'OBA_1_3',
        'mock-visao-' || lpad(n::text, 2, '0'),
        'visão sintética ' || lpad(n::text, 2, '0') || ' de ordenação, sem valor teológico',
        NULL, NULL, false, NULL
      FROM generate_series(1, 11) AS n
    `;
  }, 30_000);

  afterAll(async () => {
    await sql.end();
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 30_000);

  it("verso inexistente → null (não erro)", async () => {
    const result = await getExegesis(sql, "PHM_1_1" as CanonicalId, { authorizedLevels: ["public"] });
    expect(result).toBeNull();
  });

  it("verso deuterocanônico → null (canon_status fora do MVP, hard filter fixo)", async () => {
    const result = await getExegesis(sql, "OBA_1_2" as CanonicalId, { authorizedLevels: ["public", "curated"] });
    expect(result).toBeNull();
  });

  it("originalWords traz join de strongs quando resolve, e strongId=null preservado quando não resolve", async () => {
    const result = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["public"] });
    expect(result).not.toBeNull();
    expect(result?.originalWords).toHaveLength(2);

    const resolved = result?.originalWords[0];
    expect(resolved?.strongId).toBe("H0001");
    expect(resolved?.strong).toEqual({
      id: "H0001",
      language: "hebrew",
      lemma: "מוֹק",
      transliteration: "mock",
      definition: "definição sintética de mock",
    });

    const extended = result?.originalWords[1];
    expect(extended?.strongId).toBeNull();
    expect(extended?.strongRaw).toBe("H90001");
    expect(extended?.strong).toBeUndefined();
  });

  it("interpretations divergentes vêm como 2 entradas distintas, nunca fundidas", async () => {
    const result = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["public"] });
    expect(result?.interpretations).toHaveLength(2);
    expect(result?.interpretations[0]?.viewLabel).toBe("mock-visao-a");
    expect(result?.interpretations[1]?.viewLabel).toBe("mock-visao-b");
    expect(result?.interpretations[0]?.text).not.toBe(result?.interpretations[1]?.text);
    expect(result).not.toHaveProperty("summary");
  });

  it("hard filter: verse_text com authorized_levels não permitido NÃO aparece", async () => {
    const result = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["public"] });
    expect(result?.texts).toHaveLength(1);
    expect(result?.texts[0]?.translation).toBe("mock-a");
  });

  it("com nível 'curated' autorizado, o texto restrito aparece (hard filter é positivo, não exclusão cega)", async () => {
    const result = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["curated"] });
    expect(result?.texts).toHaveLength(1);
    expect(result?.texts[0]?.translation).toBe("mock-b");
  });

  it("interpretations ordenam por id NUMÉRICO, não lexicográfico (>=10 linhas, atravessa a casa das dezenas)", async () => {
    const result = await getExegesis(sql, "OBA_1_3" as CanonicalId, { authorizedLevels: ["public"] });
    expect(result?.interpretations).toHaveLength(11);

    // Ordem de inserção esperada (view_label monotônico 01..11) — se o ORDER BY caísse no
    // ALIAS de saída (`id::text`), a ordem seria lexicográfica ("mock-visao-01", "mock-visao-10",
    // "mock-visao-11", "mock-visao-02", ...), quebrando esta asserção.
    expect(result?.interpretations.map((i) => i.viewLabel)).toEqual(
      Array.from({ length: 11 }, (_, index) => `mock-visao-${String(index + 1).padStart(2, "0")}`),
    );

    const ids = result?.interpretations.map((i) => Number(i.id)) ?? [];
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // ids são a PK serial inteira — confere que a coluna atravessou a casa das dezenas de fato.
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(10);
  });

  it("ordenação estável: duas execuções da mesma consulta devolvem a mesma ordem", async () => {
    const first = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["public", "curated"] });
    const second = await getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: ["public", "curated"] });
    expect(second).toEqual(first);
    expect(second?.texts.map((t) => t.translation)).toEqual(first?.texts.map((t) => t.translation));
    expect(second?.originalWords.map((w) => w.position)).toEqual(first?.originalWords.map((w) => w.position));
    expect(second?.interpretations.map((i) => i.id)).toEqual(first?.interpretations.map((i) => i.id));
  });

  it("authorizedLevels vazio explode (bug de chamada, não deveria acontecer)", async () => {
    await expect(getExegesis(sql, "OBA_1_1" as CanonicalId, { authorizedLevels: [] })).rejects.toThrow(
      /authorizedLevels vazio/,
    );
  });
});

// --- sanidade contra o dado real do compose (skipIf sem DATABASE_URL) ------

describe.skipIf(!realDataLoaded)("getExegesis — sanidade contra o dado real carregado (skipIf)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(ADMIN_DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("GEN_1_1 tem 3 texts (KJV/BLIVRE/WEB, Fase 1) e originalWords não-vazias com joins resolvidos", async () => {
    const result = await getExegesis(sql, "GEN_1_1" as CanonicalId, { authorizedLevels: ["public", "curated"] });
    expect(result).not.toBeNull();
    // 3 = número de traduções carregadas pela Fase 1 (KJV, BLIVRE, WEB) — não é mágico, é o
    // manifest atual de `data/canonical/verse_texts/` para GEN_1_1 (ver docs/plano-fechamento-fase1.md).
    expect(result?.texts.length).toBe(3);
    expect(result?.originalWords.length).toBeGreaterThan(0);
    const withStrong = result?.originalWords.filter((w) => w.strong !== undefined) ?? [];
    expect(withStrong.length).toBeGreaterThan(0);
  });
});
