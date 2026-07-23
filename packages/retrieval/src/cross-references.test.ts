import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { User } from "@bereia/core";
import {
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_VISITED_NODES,
  MAX_HOPS_CEILING,
  getCrossReferences,
} from "./cross-references.js";

/**
 * Ancorado no comando de aceite do N5 (plano §7, linha N5):
 * `skipIf(!DATABASE_URL)`: maxHops limita profundidade; ciclo no grafo não
 * laça (anti-ciclo); ordem de saída total e estável; verso não autorizado
 * não vaza.
 *
 * - UNIT (sempre roda, sem rede): validação de `maxHops`/`limit`/
 *   `maxVisitedNodes` explode ANTES de qualquer chamada ao Postgres — provado
 *   com um `sql` fake que lança se invocado.
 * - INTEGRAÇÃO (skipIf sem Postgres acessível — nunca verde falso): banco de
 *   teste efêmero por suíte, grafo fixture pequeno e SINTÉTICO (ids canônicos
 *   válidos, nada teológico real): ciclo A→B→A, cadeia A→B→C→D, fan-in em F
 *   (A→F direto e B→F mais longo) para provar "menor hop", e um alvo E não
 *   autorizado para o usuário 'public'.
 * - SANIDADE contra o compose real (skipIf sem dado carregado): GEN_1_1 tem
 *   vizinhos reais; duas execuções idênticas.
 */

// --- unit: validação explode ANTES de qualquer chamada ao Postgres ---------

/** `sql` fake que EXPLODE se invocado — prova que a validação acontece antes de qualquer I/O. */
function unreachableSql(): postgres.Sql {
  const fn = () => {
    throw new Error("cross-references.test: sql não deveria ser chamado — validação deveria explodir antes");
  };
  return fn as unknown as postgres.Sql;
}

const PUBLIC_USER: User = { id: "user-mock-1", accessLevels: ["public"] };

describe("getCrossReferences — unit (validação, sem rede)", () => {
  it(`maxHops default é ${String(DEFAULT_MAX_HOPS)} e teto é ${String(MAX_HOPS_CEILING)}`, () => {
    expect(DEFAULT_MAX_HOPS).toBe(1);
    expect(MAX_HOPS_CEILING).toBe(3);
  });

  it("maxHops acima do teto (3) explode com mensagem clara, sem tocar o Postgres", async () => {
    await expect(
      getCrossReferences(unreachableSql(), "GEN_1_1", { user: PUBLIC_USER, maxHops: 4 }),
    ).rejects.toThrow(/maxHops=4 excede o teto de 3/);
  });

  it("maxHops não-inteiro/negativo explode", async () => {
    await expect(
      getCrossReferences(unreachableSql(), "GEN_1_1", { user: PUBLIC_USER, maxHops: 0 }),
    ).rejects.toThrow(/maxHops deve ser um inteiro/);
    await expect(
      getCrossReferences(unreachableSql(), "GEN_1_1", { user: PUBLIC_USER, maxHops: 1.5 }),
    ).rejects.toThrow(/maxHops deve ser um inteiro/);
  });

  it("limit inválido explode", async () => {
    await expect(
      getCrossReferences(unreachableSql(), "GEN_1_1", { user: PUBLIC_USER, limit: 0 }),
    ).rejects.toThrow(/limit deve ser um inteiro/);
  });

  it("maxVisitedNodes inválido explode", async () => {
    await expect(
      getCrossReferences(unreachableSql(), "GEN_1_1", { user: PUBLIC_USER, maxVisitedNodes: -1 }),
    ).rejects.toThrow(/maxVisitedNodes deve ser um inteiro/);
  });

  it("canonicalId inválido explode (fronteira Zod), sem tocar o Postgres", async () => {
    await expect(getCrossReferences(unreachableSql(), "not-an-id", { user: PUBLIC_USER })).rejects.toThrow();
  });
});

// --- integração real — Postgres efêmero (skipIf inacessível) ---------------

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

/** `packages/core/drizzle/`, resolvido relativo a este módulo (mesma convenção do N10 de ingestion). */
const CORE_DRIZZLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/drizzle");

async function applyMigrations(sql: postgres.Sql): Promise<void> {
  for (const fileName of ["0000_init.sql", "0001_original_words_edition.sql"]) {
    const sqlText = readFileSync(path.join(CORE_DRIZZLE_DIR, fileName), "utf8");
    await sql.begin((tx) => tx.unsafe(sqlText));
  }
}

// --- fixture sintético (mock, marcado — nenhum dado teológico real) --------
//
// Grafo (todas as edges kind='tsk'):
//   A -> B         (vizinho direto — default maxHops=1)
//   B -> A         (ciclo — não deve laçar nem duplicar)
//   B -> C         (hop2 a partir de A)
//   C -> D         (hop3 a partir de A)
//   A -> F         (F também alcançável em 1 hop — testa "menor hop")
//   B -> F         (caminho mais longo até F — NÃO deve aparecer no resultado)
//   A -> E         (E só é autorizado para 'curated', não para 'public')
//
// A=GEN_1_1 B=GEN_1_2 C=EXO_1_1 D=LEV_1_1 E=LEV_1_2 F=LEV_1_3 — ids canônicos
// válidos (USFM), estrutura sintética, sem nenhuma afirmação teológica.

const A = "GEN_1_1";
const B = "GEN_1_2";
const C = "EXO_1_1";
const D = "LEV_1_1";
const E = "LEV_1_2";
const F = "LEV_1_3";

const FIXTURE_VERSES: { id: string; book: string; chapter: number; verse: number }[] = [
  { id: A, book: "GEN", chapter: 1, verse: 1 },
  { id: B, book: "GEN", chapter: 1, verse: 2 },
  { id: C, book: "EXO", chapter: 1, verse: 1 },
  { id: D, book: "LEV", chapter: 1, verse: 1 },
  { id: E, book: "LEV", chapter: 1, verse: 2 },
  { id: F, book: "LEV", chapter: 1, verse: 3 },
];

const FIXTURE_EDGES: { sourceId: string; targetId: string }[] = [
  { sourceId: A, targetId: B },
  { sourceId: B, targetId: A },
  { sourceId: B, targetId: C },
  { sourceId: C, targetId: D },
  { sourceId: A, targetId: F },
  { sourceId: B, targetId: F },
  { sourceId: A, targetId: E },
];

describe.skipIf(!databaseUp)("getCrossReferences — integração (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    testDbName = `bereia_test_n5_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
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

    await applyMigrations(sql);

    for (const verse of FIXTURE_VERSES) {
      await sql`
        INSERT INTO canonical_verses (id, book, chapter, verse, canon_status)
        VALUES (${verse.id}, ${verse.book}, ${verse.chapter}, ${verse.verse}, 'protestant')
      `;
      // Literal de array formatado à mão (não `sql.array(...)`) pelo mesmo motivo
      // documentado em `cross-references.ts#formatTextArrayLiteral`: evita a
      // corrida de inferência de tipo do driver numa conexão recém-aberta.
      const authorizedLevelsLiteral = verse.id === E ? "{curated}" : "{public}";
      await sql`
        INSERT INTO verse_texts (canonical_id, translation, text, authorized_levels)
        VALUES (${verse.id}, 'KJV', ${"mock texto placeholder " + verse.id}, ${authorizedLevelsLiteral}::text[])
      `;
    }
    for (const edge of FIXTURE_EDGES) {
      await sql`
        INSERT INTO edges (source_id, target_id, kind)
        VALUES (${edge.sourceId}, ${edge.targetId}, 'tsk')
      `;
    }
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

  it("default maxHops=1: só os vizinhos diretos (B e F), nunca C/D/E", async () => {
    const edges = await getCrossReferences(sql, A, { user: PUBLIC_USER });
    expect(edges).toEqual([
      { sourceId: A, targetId: B, kind: "tsk" },
      { sourceId: A, targetId: F, kind: "tsk" },
    ]);
  });

  it("maxHops=2: alcança C (via B) mas não D (precisaria de hop3)", async () => {
    const edges = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 2 });
    expect(edges).toEqual([
      { sourceId: A, targetId: B, kind: "tsk" },
      { sourceId: A, targetId: F, kind: "tsk" },
      { sourceId: B, targetId: C, kind: "tsk" },
    ]);
  });

  it("maxHops=3: alcança D; ciclo B→A não laça nem duplica A no resultado", async () => {
    const edges = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3 });
    expect(edges).toEqual([
      { sourceId: A, targetId: B, kind: "tsk" },
      { sourceId: A, targetId: F, kind: "tsk" },
      { sourceId: B, targetId: C, kind: "tsk" },
      { sourceId: C, targetId: D, kind: "tsk" },
    ]);
    // A nunca aparece como alvo — o ciclo B→A não "referencia de volta" a origem.
    expect(edges.some((edge) => edge.targetId === A)).toBe(false);
  });

  it("maxHops=4 explode (teto=3), mesmo com o banco disponível", async () => {
    await expect(getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 4 })).rejects.toThrow(
      /excede o teto de 3/,
    );
  });

  it("menor-hop correto: F é alcançado em 1 hop (A→F) — a edge mais longa B→F NÃO aparece", async () => {
    const edges = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3 });
    const toF = edges.filter((edge) => edge.targetId === F);
    expect(toF).toEqual([{ sourceId: A, targetId: F, kind: "tsk" }]);
  });

  it("verso não autorizado não vaza: E (authorized_levels=['curated']) some da lista para o usuário 'public'", async () => {
    const edges = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3 });
    expect(edges.some((edge) => edge.targetId === E)).toBe(false);
  });

  it("usuário com accessLevels ['public','curated'] consegue ver E — overlap, não lista negra fixa", async () => {
    // O hard filter também vale para o PRÓPRIO verso de partida (A só tem
    // authorized_levels=['public']) — um usuário só 'curated' nem alcançaria
    // A. Por isso o teste usa um usuário com AMBOS os níveis, isolando
    // especificamente o comportamento de overlap em E (só 'curated').
    const bothLevelsUser: User = { id: "user-mock-2", accessLevels: ["public", "curated"] };
    const edges = await getCrossReferences(sql, A, { user: bothLevelsUser, maxHops: 1 });
    expect(edges.some((edge) => edge.targetId === E)).toBe(true);
    expect(edges.some((edge) => edge.targetId === B)).toBe(true);
  });

  it("usuário só 'curated' não alcança nem o próprio verso de partida A (authorized_levels=['public']) — devolve []", async () => {
    const curatedOnlyUser: User = { id: "user-mock-3", accessLevels: ["curated"] };
    const edges = await getCrossReferences(sql, A, { user: curatedOnlyUser, maxHops: 1 });
    expect(edges).toEqual([]);
  });

  it("verso de partida não autorizado devolve [] (nunca vaza suas cross-refs)", async () => {
    const edges = await getCrossReferences(sql, E, { user: PUBLIC_USER, maxHops: 1 });
    expect(edges).toEqual([]);
  });

  it("ordem de saída total e estável: 2 execuções da mesma query são idênticas", async () => {
    const first = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3 });
    const second = await getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3 });
    expect(second).toEqual(first);
  });

  it("explode quando o conjunto alcançado excede maxVisitedNodes (teto sensato, testável)", async () => {
    // Com maxHops=1 a partir de A o conjunto alcançado é {B, F} = 2 nós — um teto de 1 estoura.
    await expect(
      getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 1, maxVisitedNodes: 1 }),
    ).rejects.toThrow(/maxVisitedNodes=1/);
  });

  it("maxVisitedNodes default é generoso o suficiente para não estourar no fixture", async () => {
    await expect(
      getCrossReferences(sql, A, { user: PUBLIC_USER, maxHops: 3, maxVisitedNodes: DEFAULT_MAX_VISITED_NODES }),
    ).resolves.not.toThrow();
  });

  it("canonicalId inexistente devolve []", async () => {
    const edges = await getCrossReferences(sql, "MAT_1_1", { user: PUBLIC_USER });
    expect(edges).toEqual([]);
  });
});

// --- sanidade contra o compose real (skipIf sem dado carregado) ------------

async function probeRealDataLoaded(url: string): Promise<boolean> {
  if (!(await probeDatabaseUp(url))) return false;
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM canonical_verses WHERE id = 'GEN_1_1') AS exists
    `;
    return rows[0]?.exists === true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const realDataLoaded = await probeRealDataLoaded(ADMIN_DATABASE_URL);

describe.skipIf(!realDataLoaded)("getCrossReferences — sanidade contra o compose real (dado carregado)", () => {
  let realSql: postgres.Sql;

  beforeAll(() => {
    realSql = postgres(ADMIN_DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await realSql.end();
  });

  it("GEN_1_1 tem vizinhos reais (maxHops=1, usuário 'public')", async () => {
    const edges = await getCrossReferences(realSql, "GEN_1_1", { user: PUBLIC_USER });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => edge.sourceId === "GEN_1_1")).toBe(true);
  });

  it("2 execuções idênticas contra o dado real", async () => {
    const first = await getCrossReferences(realSql, "GEN_1_1", { user: PUBLIC_USER });
    const second = await getCrossReferences(realSql, "GEN_1_1", { user: PUBLIC_USER });
    expect(second).toEqual(first);
  });
});
