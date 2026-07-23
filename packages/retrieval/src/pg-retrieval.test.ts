import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { CanonicalId, RetrievalService, User } from "@bereia/core";
import { PgRetrieval, type QueryEmbedder } from "@bereia/retrieval";

/**
 * Ancorado no comando de aceite do N6 (plano §7, linha N6): `PgRetrieval`
 * satisfaz o tipo `RetrievalService` (typecheck); smoke das 4 operações
 * (searchByTheme/getVerse/getExegesis/getCrossReferences — o port ganhou
 * `getExegesis` em N1/ADR-010) pelo barrel; resolve por `@bereia/retrieval`.
 *
 * Tudo neste arquivo é importado APENAS via `@bereia/retrieval` (prova o
 * barrel) — exceto o próprio port/tipos do core (`RetrievalService`, `User`,
 * `CanonicalId`), que são a fronteira externa que `PgRetrieval` implementa,
 * não algo que o barrel deveria reexportar.
 *
 * Padrão N3/N4/N5: banco de teste EFÊMERO (CREATE/DROP DATABASE, nome
 * único) com migrations reais e fixtures SINTÉTICAS marcadas como mock —
 * zero conteúdo teológico real.
 */

const DIMENSIONS = 1024;

function zeroVector(): number[] {
  return new Array(DIMENSIONS).fill(0);
}

function axisVector(index: number): number[] {
  const v = zeroVector();
  v[index] = 1;
  return v;
}

function formatVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

function makeFixedQueryEmbedder(vector: readonly number[]): QueryEmbedder {
  return {
    async embedQuery() {
      return [...vector];
    },
  };
}

function makeUser(accessLevels: readonly ("public" | "curated")[]): User {
  return { id: "mock-user", accessLevels: [...accessLevels] };
}

// --- (a) typecheck-level: PgRetrieval satisfaz RetrievalService ------------

describe("PgRetrieval — conformidade de tipo com RetrievalService", () => {
  it("PgRetrieval implementa RetrievalService (checado em tempo de compilação e em runtime)", () => {
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;
    const fakeEmbedder = makeFixedQueryEmbedder(axisVector(0));

    // A linha abaixo é a prova de tipo: se `PgRetrieval` não satisfizer
    // `RetrievalService` (mesma assinatura das 4 operações do port), o
    // typecheck do pacote reprova aqui — não é um cast, é atribuição direta.
    const svc: RetrievalService = new PgRetrieval({ sql: fakeSql, embedder: fakeEmbedder });

    expect(svc).toBeInstanceOf(PgRetrieval);
    expect(typeof svc.searchByTheme).toBe("function");
    expect(typeof svc.getVerse).toBe("function");
    expect(typeof svc.getExegesis).toBe("function");
    expect(typeof svc.getCrossReferences).toBe("function");
  });
});

// --- (b) smoke das 4 operações contra banco efêmero (skipIf sem DATABASE_URL) ---

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

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/drizzle");

function readMigration(fileName: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

describe.skipIf(!databaseUp)("PgRetrieval — smoke das 4 operações (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let sql: ReturnType<typeof postgres>;
  let svc: RetrievalService;

  const publicUser = makeUser(["public"]);

  beforeAll(async () => {
    testDbName = `bereia_test_n6_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
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
    // OBA_1_1: texto autorizado 'public', embedding EXATAMENTE no eixo 0 (mesmo
    // vetor que o embedder fake devolve) — verso "visível" de ponta a ponta.
    // OBA_1_2: existe no cânon, mas o único texto é autorizado só 'curated' —
    // prova a nuance de `getVerse`/`getExegesis` retocada neste nó: verso
    // existente + hard filter total → objeto não-nulo com `texts: []`, nunca
    // `null` (que é reservado a verso INEXISTENTE, ver `PHM_1_1` abaixo).
    // OBA_1_3: texto autorizado 'public', embedding no eixo 1 (mais distante da
    // query) — alcançável tanto pela busca temática quanto pelas cross-refs.
    await sql`
      INSERT INTO canonical_verses (id, book, chapter, verse, canon_status, theological_category)
      VALUES
        ('OBA_1_1', 'OBA', 1, 1, 'protestant', NULL),
        ('OBA_1_2', 'OBA', 1, 2, 'protestant', NULL),
        ('OBA_1_3', 'OBA', 1, 3, 'protestant', NULL)
    `;

    const publicLiteral = formatTextArrayLiteral(["public"]);
    const curatedLiteral = formatTextArrayLiteral(["curated"]);
    const axis0Literal = formatVectorLiteral(axisVector(0));
    const axis1Literal = formatVectorLiteral(axisVector(1));

    await sql`
      INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
      VALUES
        ('OBA_1_1', 'mock', 'texto sintético de mock (OBA_1_1), sem valor teológico', ${axis0Literal}::vector, ${publicLiteral}::text[]),
        ('OBA_1_2', 'mock', 'texto sintético restrito de mock (OBA_1_2), sem valor teológico', NULL, ${curatedLiteral}::text[]),
        ('OBA_1_3', 'mock', 'texto sintético de mock (OBA_1_3), sem valor teológico', ${axis1Literal}::vector, ${publicLiteral}::text[])
    `;

    // Cross-refs: OBA_1_1 -> OBA_1_2 (alvo bloqueado pelo hard filter para o
    // usuário 'public') e OBA_1_1 -> OBA_1_3 (alvo visível) — prova que o
    // hard filter corta a ponte não autorizada, mas deixa passar a autorizada.
    await sql`
      INSERT INTO edges (source_id, target_id, kind)
      VALUES
        ('OBA_1_1', 'OBA_1_2', 'tsk'),
        ('OBA_1_1', 'OBA_1_3', 'tsk')
    `;

    svc = new PgRetrieval({ sql, embedder: makeFixedQueryEmbedder(axisVector(0)) });
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

  it("searchByTheme: hard filter + ranking exato via composição (embedding NULL de OBA_1_2 nunca ranqueia)", async () => {
    const result = await svc.searchByTheme("consulta sintética", publicUser);
    expect(result.map((r) => r.canonicalId)).toEqual(["OBA_1_1", "OBA_1_3"]);
    expect(result.some((r) => r.canonicalId === "OBA_1_2")).toBe(false);
  });

  it("getVerse: verso existente com texto autorizado devolve texts não-vazio", async () => {
    const result = await svc.getVerse("OBA_1_1" as CanonicalId, publicUser);
    expect(result).not.toBeNull();
    expect(result?.texts).toHaveLength(1);
    expect(result?.texts[0]?.translation).toBe("mock");
  });

  it("getVerse: verso existente cujo único texto é filtrado pelo hard filter devolve objeto não-nulo com texts: [] (nuance retocada no docstring do port)", async () => {
    const result = await svc.getVerse("OBA_1_2" as CanonicalId, publicUser);
    expect(result).not.toBeNull();
    expect(result?.texts).toEqual([]);
  });

  it("getVerse: verso INEXISTENTE no cânon devolve null (nunca confundido com texts: [])", async () => {
    const result = await svc.getVerse("PHM_1_1" as CanonicalId, publicUser);
    expect(result).toBeNull();
  });

  it("getExegesis: verso existente devolve texts/originalWords/interpretations coerentes (arrays vazios quando não há linha)", async () => {
    const result = await svc.getExegesis("OBA_1_1" as CanonicalId, publicUser);
    expect(result).not.toBeNull();
    expect(result?.texts).toHaveLength(1);
    expect(result?.originalWords).toEqual([]);
    expect(result?.interpretations).toEqual([]);
  });

  it("getExegesis: verso INEXISTENTE devolve null", async () => {
    const result = await svc.getExegesis("PHM_1_1" as CanonicalId, publicUser);
    expect(result).toBeNull();
  });

  it("getCrossReferences: hard filter corta a ponte não autorizada (OBA_1_2), deixa passar a autorizada (OBA_1_3)", async () => {
    const result = await svc.getCrossReferences("OBA_1_1" as CanonicalId, publicUser);
    expect(result.map((e) => e.targetId)).toEqual(["OBA_1_3"]);
  });

  it("determinismo de ponta a ponta: a mesma chamada 2× devolve resultado idêntico em todas as operações", async () => {
    const [searchFirst, searchSecond] = await Promise.all([
      svc.searchByTheme("consulta sintética", publicUser),
      svc.searchByTheme("consulta sintética", publicUser),
    ]);
    expect(searchSecond).toEqual(searchFirst);

    const [crossFirst, crossSecond] = await Promise.all([
      svc.getCrossReferences("OBA_1_1" as CanonicalId, publicUser),
      svc.getCrossReferences("OBA_1_1" as CanonicalId, publicUser),
    ]);
    expect(crossSecond).toEqual(crossFirst);
  });
});
