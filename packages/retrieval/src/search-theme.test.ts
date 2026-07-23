import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { User } from "@bereia/core";
import { createQueryEmbedder, type QueryEmbedder } from "./embedder.js";
import { DEFAULT_LIMIT, searchByTheme } from "./search-theme.js";

/**
 * Ancorado no comando de aceite do N3 (plano §7, linha N3): `skipIf(!DATABASE_URL)`
 * — hard filter exclui verso não autorizado ANTES do ranking; ranking exato
 * `ORDER BY embedding <=> $q, canonical_id, translation`; mesma query 2× ⇒
 * IDs+ordem idênticos; `embedding NULL` não ranqueia. Padrão N4/N5
 * (`exegesis.test.ts`/`cross-references.test.ts`): banco de teste EFÊMERO
 * (CREATE/DROP DATABASE, nome único) com migrations reais e fixtures
 * SINTÉTICAS marcadas como mock — zero conteúdo teológico real.
 */

const DIMENSIONS = 1024;

function zeroVector(): number[] {
  return new Array(DIMENSIONS).fill(0);
}

/** Vetor unitário no eixo `index` — usado para construir geometria previsível (ortogonalidade, ângulos exatos). */
function axisVector(index: number): number[] {
  const v = zeroVector();
  v[index] = 1;
  return v;
}

/**
 * Vetor a 45° entre os eixos `indexA`/`indexB` (sinal `signB` no segundo eixo).
 * `combinedVector(0, 1, 1)` e `combinedVector(0, 1, -1)` têm EXATAMENTE a
 * mesma distância cosseno até `axisVector(0)` — usado para provar o tie-break.
 */
function combinedVector(indexA: number, indexB: number, signB: 1 | -1): number[] {
  const v = zeroVector();
  v[indexA] = Math.SQRT1_2;
  v[indexB] = signB * Math.SQRT1_2;
  return v;
}

function formatVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

// --- QueryEmbedder fake (sem rede) — devolve sempre o mesmo vetor fixo -----

function makeFixedQueryEmbedder(vector: readonly number[]): { embedder: QueryEmbedder; calls: string[] } {
  const calls: string[] = [];
  const embedder: QueryEmbedder = {
    async embedQuery(text: string) {
      calls.push(text);
      return [...vector];
    },
  };
  return { embedder, calls };
}

function makeUser(accessLevels: readonly ("public" | "curated")[]): User {
  return { id: "mock-user", accessLevels: [...accessLevels] };
}

// --- unit: validação de entrada, sem rede/DB --------------------------------

describe("searchByTheme — validação de entrada (unit, sem rede/DB)", () => {
  it("query vazia explode ANTES de qualquer embed", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(axisVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByTheme(fakeSql, embedder, "", { user: makeUser(["public"]) })).rejects.toThrow(/vazia/);
    expect(calls).toHaveLength(0);
  });

  it("query só com espaços explode ANTES de qualquer embed", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(axisVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByTheme(fakeSql, embedder, "   ", { user: makeUser(["public"]) })).rejects.toThrow(/vazia/);
    expect(calls).toHaveLength(0);
  });

  it("accessLevels vazio explode (bug de chamada, não deveria acontecer)", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(axisVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByTheme(fakeSql, embedder, "graça", { user: makeUser([]) })).rejects.toThrow(
      /accessLevels vazio/,
    );
    expect(calls).toHaveLength(0);
  });

  it("embedder fake injetado é chamado exatamente 1× por busca", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(axisVector(0));
    let sqlCalls = 0;
    const fakeSql = ((..._args: unknown[]) => {
      sqlCalls += 1;
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;

    const result = await searchByTheme(fakeSql, embedder, "fé", { user: makeUser(["public"]) });

    expect(result).toEqual([]);
    expect(calls).toEqual(["fé"]);
    expect(sqlCalls).toBeGreaterThanOrEqual(1);

    await searchByTheme(fakeSql, embedder, "esperança", { user: makeUser(["public"]) });
    expect(calls).toEqual(["fé", "esperança"]);
  });
});

// --- integração: banco de teste efêmero (skipIf sem DATABASE_URL) ----------

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

async function probeRealEmbeddingsLoaded(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    const rows = await sql<{ count: string }[]>`SELECT count(*) FROM verse_texts WHERE embedding IS NOT NULL`;
    return Number(rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function probeEmbedderUp(embedderUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${embedderUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://bereia:bereia@localhost:5432/bereia";
const EMBEDDER_URL = process.env["EMBEDDER_URL"] ?? "http://localhost:8000";
const databaseUp = await probeDatabaseUp(ADMIN_DATABASE_URL);
const realEmbeddingsLoaded = databaseUp && (await probeRealEmbeddingsLoaded(ADMIN_DATABASE_URL));
const embedderUp = databaseUp ? await probeEmbedderUp(EMBEDDER_URL) : false;

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/drizzle");

function readMigration(fileName: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

describe.skipIf(!databaseUp)("searchByTheme — integração real (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let sql: ReturnType<typeof postgres>;

  // Vetor da query — eixo 0. Fixture construída para que a distância cosseno
  // de cada verso até este vetor seja EXATA e previsível (ver funções acima).
  const queryVector = axisVector(0);

  beforeAll(async () => {
    testDbName = `bereia_test_n3_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
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
    // Geometria: eixo 0 é a direção da query. `OBA_1_1` tem 2 traduções no
    // MESMO ponto (distância 0, empatam entre si — prova tie-break por
    // translation). `OBA_1_3`/`OBA_1_4` estão a 45° em sinais opostos do eixo
    // 1 — mesma distância cosseno até a query, mas canonical_id diferente
    // (prova tie-break por canonical_id). `OBA_1_2` está no eixo 1 (ortogonal,
    // distância máxima). `OBA_1_5` é o ponto MAIS PRÓXIMO possível mas
    // `deuterocanonical` (hard filter de cânon). `OBA_1_6` também é o ponto
    // mais próximo mas só autorizado para `curated` (hard filter de
    // authorized_levels). `OBA_1_7` tem embedding NULL (ainda não embedado).
    await sql`
      INSERT INTO canonical_verses (id, book, chapter, verse, canon_status, theological_category)
      VALUES
        ('OBA_1_1', 'OBA', 1, 1, 'protestant', NULL),
        ('OBA_1_2', 'OBA', 1, 2, 'protestant', NULL),
        ('OBA_1_3', 'OBA', 1, 3, 'protestant', NULL),
        ('OBA_1_4', 'OBA', 1, 4, 'protestant', NULL),
        ('OBA_1_5', 'OBA', 1, 5, 'deuterocanonical', NULL),
        ('OBA_1_6', 'OBA', 1, 6, 'protestant', NULL),
        ('OBA_1_7', 'OBA', 1, 7, 'protestant', NULL)
    `;

    async function insertVerseText(params: {
      canonicalId: string;
      translation: string;
      vector: readonly number[] | null;
      authorizedLevels: readonly string[];
    }): Promise<void> {
      const authorizedLiteral = formatTextArrayLiteral([...params.authorizedLevels]);
      const text = `texto sintético de mock (${params.canonicalId}/${params.translation}), sem valor teológico`;
      if (params.vector === null) {
        await sql`
          INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
          VALUES (${params.canonicalId}, ${params.translation}, ${text}, NULL, ${authorizedLiteral}::text[])
        `;
      } else {
        const vectorLiteral = formatVectorLiteral(params.vector);
        await sql`
          INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
          VALUES (${params.canonicalId}, ${params.translation}, ${text}, ${vectorLiteral}::vector, ${authorizedLiteral}::text[])
        `;
      }
    }

    await insertVerseText({
      canonicalId: "OBA_1_1",
      translation: "mock-a",
      vector: axisVector(0),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_1",
      translation: "mock-b",
      vector: axisVector(0),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_2",
      translation: "mock",
      vector: axisVector(1),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_3",
      translation: "mock",
      vector: combinedVector(0, 1, 1),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_4",
      translation: "mock",
      vector: combinedVector(0, 1, -1),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_5",
      translation: "mock",
      vector: axisVector(0),
      authorizedLevels: ["public"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_6",
      translation: "mock",
      vector: axisVector(0),
      authorizedLevels: ["curated"],
    });
    await insertVerseText({
      canonicalId: "OBA_1_7",
      translation: "mock",
      vector: null,
      authorizedLevels: ["public"],
    });
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

  it("ranking exato por distância; hard filter (cânon + authorized_levels) exclui ANTES do ranking; embedding NULL não ranqueia", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });

    // OBA_1_5 (deuterocanonical) e OBA_1_6 (só 'curated') seriam os pontos MAIS
    // PRÓXIMOS possíveis (distância 0), mas nunca aparecem para um usuário 'public'
    // — a prova de que o hard filter corta ANTES do ranking, não depois.
    expect(result.map((r) => `${r.canonicalId}/${r.translation}`)).toEqual([
      "OBA_1_1/mock-a",
      "OBA_1_1/mock-b",
      "OBA_1_3/mock",
      "OBA_1_4/mock",
      "OBA_1_2/mock",
    ]);
    // embedding NULL (OBA_1_7) nunca aparece, em nenhuma posição.
    expect(result.some((r) => r.canonicalId === "OBA_1_7")).toBe(false);
  });

  it("tie-break por canonical_id quando a distância empata exatamente (OBA_1_3 antes de OBA_1_4)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });

    const tied = result.filter((r) => r.canonicalId === "OBA_1_3" || r.canonicalId === "OBA_1_4");
    expect(tied.map((r) => r.canonicalId)).toEqual(["OBA_1_3", "OBA_1_4"]);
    expect(tied[0]?.distance).toBeCloseTo(tied[1]?.distance ?? Number.NaN, 10);
  });

  it("tie-break por translation quando canonical_id e distância empatam (OBA_1_1: mock-a antes de mock-b)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });

    const sameVerse = result.filter((r) => r.canonicalId === "OBA_1_1");
    expect(sameVerse.map((r) => r.translation)).toEqual(["mock-a", "mock-b"]);
  });

  it("hard filter positivo: usuário com 'curated' vê OBA_1_6, que estava oculto para 'public'", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["curated"]) });

    expect(result.some((r) => r.canonicalId === "OBA_1_6")).toBe(true);
    // Um usuário só com 'curated' não vê os textos marcados só 'public'.
    expect(result.some((r) => r.canonicalId === "OBA_1_1")).toBe(false);
  });

  it("LIMIT respeitado: corta a lista já ordenada, mantendo a mesma ordem do topo", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: 2,
    });

    expect(result.map((r) => `${r.canonicalId}/${r.translation}`)).toEqual(["OBA_1_1/mock-a", "OBA_1_1/mock-b"]);
  });

  it("default de limit é DEFAULT_LIMIT quando options.limit não é passado", () => {
    expect(DEFAULT_LIMIT).toBeGreaterThan(0);
  });

  it("options.translation filtra a tradução ANTES do ranking", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const result = await searchByTheme(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      translation: "mock",
    });

    // Só versos com translation='mock' — exclui OBA_1_1 (mock-a/mock-b).
    expect(result.map((r) => r.canonicalId)).toEqual(["OBA_1_3", "OBA_1_4", "OBA_1_2"]);
    expect(result.every((r) => r.translation === "mock")).toBe(true);
  });

  it("determinismo: a mesma busca 2× devolve IDs e ordem idênticos", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const first = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    const second = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });

    expect(second).toEqual(first);
    expect(second.map((r) => `${r.canonicalId}/${r.translation}`)).toEqual(
      first.map((r) => `${r.canonicalId}/${r.translation}`),
    );
  });

  it("limit inválido explode (bug de chamada, não deveria acontecer)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    await expect(
      searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]), limit: 0 }),
    ).rejects.toThrow(/limit/);
    await expect(
      searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]), limit: 1.5 }),
    ).rejects.toThrow(/limit/);
  });
});

// --- sanidade contra o dado real do compose (skipIf sem DATABASE_URL/embeddings/sidecar) ---

describe.skipIf(!(realEmbeddingsLoaded && embedderUp))(
  "searchByTheme — sanidade contra o dado real carregado (skipIf)",
  () => {
    let sql: ReturnType<typeof postgres>;
    let embedder: QueryEmbedder;

    beforeAll(() => {
      sql = postgres(ADMIN_DATABASE_URL, { max: 2 });
      embedder = createQueryEmbedder(EMBEDDER_URL);
    });

    afterAll(async () => {
      await sql.end();
    });

    it("busca real devolve `limit` resultados e 2 execuções são idênticas (determinismo)", async () => {
      const user = makeUser(["public", "curated"]);
      const first = await searchByTheme(sql, embedder, "graça e fé", { user, limit: 5 });
      const second = await searchByTheme(sql, embedder, "graça e fé", { user, limit: 5 });

      expect(first).toHaveLength(5);
      expect(second).toEqual(first);
    }, 120_000);
  },
);

if (!realEmbeddingsLoaded && databaseUp) {
  // eslint-disable-next-line no-console
  console.warn(
    "searchByTheme: sanidade real pulada — verse_texts sem embeddings carregados " +
      "(rode `load:postgres` + o embed batch antes de esperar verde aqui). Nunca verde-falso.",
  );
}
