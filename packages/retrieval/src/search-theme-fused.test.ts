import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { User } from "@bereia/core";
import type { QueryEmbedder } from "./embedder.js";
import { PgRetrieval } from "./pg-retrieval.js";
import { searchByTheme } from "./search-theme.js";
import {
  FUSION_DENSE_K,
  FUSION_GRAPH_WEIGHT,
  FUSION_MAX_HOPS,
  FUSION_RRF_K,
  FUSION_SEED_N,
  searchByThemeFused,
} from "./search-theme-fused.js";

/**
 * Teste do N2 do Estágio 2 (fusão RRF com o grafo de cross-references,
 * `docs/plano-fase2-retrieval.md`). Padrão dos demais testes de integração do
 * pacote (`search-theme.test.ts`/`cross-references.test.ts`): banco de teste
 * EFÊMERO (CREATE/DROP DATABASE) com migrations reais e fixtures SINTÉTICAS
 * marcadas como mock — zero conteúdo teológico real.
 *
 * Geometria da fixture: um vetor unitário nos eixos 0/1 do espaço BGE-M3
 * (1024 dims, resto zero) — `angledVector(theta)` = `cos(theta)·e0 +
 * sin(theta)·e1`. Como o vetor da query é `e0` (eixo 0), a distância cosseno
 * até `angledVector(theta)` é `1 - cos(theta)`, estritamente crescente com
 * `theta` em `[0, pi]` — geometria previsível, sem depender de nenhum
 * conteúdo teológico.
 */

const DIMENSIONS = 1024;

function zeroVector(): number[] {
  return new Array(DIMENSIONS).fill(0);
}

function angledVector(theta: number): number[] {
  const v = zeroVector();
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

function formatVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

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

describe("searchByThemeFused — validação de entrada (unit, sem rede/DB)", () => {
  it("query vazia explode ANTES de qualquer embed", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(angledVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByThemeFused(fakeSql, embedder, "", { user: makeUser(["public"]) })).rejects.toThrow(
      /vazia/,
    );
    expect(calls).toHaveLength(0);
  });

  it("query só com espaços explode ANTES de qualquer embed", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(angledVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByThemeFused(fakeSql, embedder, "   ", { user: makeUser(["public"]) })).rejects.toThrow(
      /vazia/,
    );
    expect(calls).toHaveLength(0);
  });

  it("accessLevels vazio explode (bug de chamada, não deveria acontecer)", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(angledVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(searchByThemeFused(fakeSql, embedder, "graça", { user: makeUser([]) })).rejects.toThrow(
      /accessLevels vazio/,
    );
    expect(calls).toHaveLength(0);
  });

  it("limit inválido explode", async () => {
    const { embedder } = makeFixedQueryEmbedder(angledVector(0));
    const fakeSql = (() => Promise.resolve([])) as unknown as postgres.Sql;

    await expect(
      searchByThemeFused(fakeSql, embedder, "graça", { user: makeUser(["public"]), limit: 0 }),
    ).rejects.toThrow(/limit/);
  });

  it("constantes pinadas têm os valores documentados", () => {
    expect(FUSION_RRF_K).toBe(60);
    expect(FUSION_GRAPH_WEIGHT).toBe(0.5);
    expect(FUSION_DENSE_K).toBe(50);
    expect(FUSION_SEED_N).toBe(10);
    expect(FUSION_MAX_HOPS).toBe(1);
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

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://bereia:bereia@localhost:5432/bereia";
const databaseUp = await probeDatabaseUp(ADMIN_DATABASE_URL);
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/drizzle");

function readMigration(fileName: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

async function createEphemeralDatabase(prefix: string): Promise<{ sql: postgres.Sql; dbName: string }> {
  const dbName = `bereia_test_${prefix}_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${dbName}`;
  const sql = postgres(url.toString(), { max: 4 });
  await sql.begin((tx) => tx.unsafe(readMigration("0000_init.sql")));
  await sql.begin((tx) => tx.unsafe(readMigration("0001_original_words_edition.sql")));
  return { sql, dbName };
}

async function dropEphemeralDatabase(sql: postgres.Sql, dbName: string): Promise<void> {
  await sql.end();
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function insertVerse(
  sql: postgres.Sql,
  params: { id: string; book: string; chapter: number; verse: number },
): Promise<void> {
  await sql`
    INSERT INTO canonical_verses (id, book, chapter, verse, canon_status)
    VALUES (${params.id}, ${params.book}, ${params.chapter}, ${params.verse}, 'protestant')
  `;
}

async function insertVerseText(
  sql: postgres.Sql,
  params: { canonicalId: string; translation: string; vector: readonly number[]; authorizedLevels: readonly string[] },
): Promise<void> {
  const authorizedLiteral = formatTextArrayLiteral([...params.authorizedLevels]);
  const vectorLiteral = formatVectorLiteral(params.vector);
  const text = `texto sintético de mock (${params.canonicalId}/${params.translation}), sem valor teológico`;
  await sql`
    INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
    VALUES (${params.canonicalId}, ${params.translation}, ${text}, ${vectorLiteral}::vector, ${authorizedLiteral}::text[])
  `;
}

async function insertEdge(sql: postgres.Sql, sourceId: string, targetId: string): Promise<void> {
  await sql`INSERT INTO edges (source_id, target_id, kind) VALUES (${sourceId}, ${targetId}, 'tsk')`;
}

// =============================================================================
// Suíte A — mecanismo de promoção: um alvo mal ranqueado no denso (mas dentro
// do top-K), confirmado pelo grafo a partir de uma semente bem ranqueada,
// SOBE acima de concorrentes puramente densos. Espelha o caso real que
// motivou este nó ("dar a outra face": Mt 5:39 mal ranqueado no denso, ligado
// a Lc 6:29 pelo grafo).
// =============================================================================

describe.skipIf(!databaseUp)("searchByThemeFused — promoção via grafo (candidato já no top-K denso)", () => {
  let sql: postgres.Sql;
  let dbName: string;

  const queryVector = angledVector(0); // eixo 0 — mesma direção da "query"

  // S é a semente (rank1 denso, θ=0 ⇒ distância 0). A/B são concorrentes
  // puramente densos, mais próximos que T mas SEM ligação de grafo. T é o
  // alvo — o pior ranqueado do grupo denso (θ maior ⇒ mais distante), mas
  // ligado a S por uma cross-reference direta (1 hop). U é ligado a S mas só
  // autorizado 'curated' — nunca deve vazar para o usuário 'public'.
  const S = "GEN_1_1";
  const A = "GEN_1_2";
  const B = "GEN_1_3";
  const T = "GEN_1_4";
  const U = "GEN_1_5";

  beforeAll(async () => {
    const created = await createEphemeralDatabase("n2_promo");
    sql = created.sql;
    dbName = created.dbName;

    for (const [id, verse] of [
      [S, 1],
      [A, 2],
      [B, 3],
      [T, 4],
      [U, 5],
    ] as const) {
      await insertVerse(sql, { id, book: "GEN", chapter: 1, verse });
    }

    await insertVerseText(sql, { canonicalId: S, translation: "mock", vector: angledVector(0), authorizedLevels: ["public"] });
    await insertVerseText(sql, { canonicalId: A, translation: "mock", vector: angledVector(0.1), authorizedLevels: ["public"] });
    await insertVerseText(sql, { canonicalId: B, translation: "mock", vector: angledVector(0.3), authorizedLevels: ["public"] });
    await insertVerseText(sql, { canonicalId: T, translation: "mock", vector: angledVector(1.0), authorizedLevels: ["public"] });
    await insertVerseText(sql, { canonicalId: U, translation: "mock", vector: angledVector(0.5), authorizedLevels: ["curated"] });

    // S -> T: a cross-reference que promove T. S -> U: alvo bloqueado pelo
    // hard filter (nunca deve vazar para 'public').
    await insertEdge(sql, S, T);
    await insertEdge(sql, S, U);
  }, 30_000);

  afterAll(async () => {
    await dropEphemeralDatabase(sql, dbName);
  }, 30_000);

  it("busca densa pura: T é o PIOR ranqueado do grupo (última posição)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const dense = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    expect(dense.map((r) => r.canonicalId)).toEqual([S, A, B, T]);
  });

  it("fusão RRF: T é PROMOVIDO ao topo — confirmado pelo grafo a partir da semente S (rank1)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: 4,
    });

    // T recebe os DOIS termos do RRF (denso: rank4 de 4; grafo: rank1 — a
    // melhor semente possível), o que basta para superar S/A/B (que só têm
    // termo denso). A prova numérica do porquê está no docstring do módulo.
    expect(fused.map((r) => r.canonicalId)).toEqual([T, S, A, B]);
  });

  it("hard filter preservado na fusão: U (só 'curated') nunca aparece para o usuário 'public'", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: 10,
    });
    expect(fused.some((r) => r.canonicalId === U)).toBe(false);
  });

  it("usuário com 'curated' também vê U — overlap do hard filter, não lista negra fixa", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public", "curated"]),
      limit: 10,
    });
    expect(fused.some((r) => r.canonicalId === U)).toBe(true);
  });

  it("determinismo: a mesma fusão 2× devolve resultado byte-idêntico", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const first = await searchByThemeFused(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    const second = await searchByThemeFused(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    expect(second).toEqual(first);
  });

  it("embedder fake é chamado exatamente 1× por busca fundida (mesmo vetor serve para denso e grafo)", async () => {
    const { embedder, calls } = makeFixedQueryEmbedder(queryVector);
    await searchByThemeFused(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    expect(calls).toEqual(["consulta sintética"]);
  });

  // --- wiring: PgRetrieval.fuseCrossReferences ------------------------------

  it("PgRetrieval com fuseCrossReferences=false (default) é IDÊNTICO a searchByTheme puro", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const svc = new PgRetrieval({ sql, embedder });
    const viaService = await svc.searchByTheme("consulta sintética", makeUser(["public"]));
    const viaDirect = await searchByTheme(sql, embedder, "consulta sintética", { user: makeUser(["public"]) });
    expect(viaService).toEqual(viaDirect);
    // Sem a fusão, T continua na última posição (nenhuma promoção).
    expect(viaService.map((r) => r.canonicalId)).toEqual([S, A, B, T]);
  });

  it("PgRetrieval com fuseCrossReferences=true delega à fusão — T promovido, igual a searchByThemeFused direto", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const svc = new PgRetrieval({ sql, embedder, fuseCrossReferences: true });
    const viaService = await svc.searchByTheme("consulta sintética", makeUser(["public"]), { limit: 4 });
    const viaDirect = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: 4,
    });
    expect(viaService).toEqual(viaDirect);
    expect(viaService.map((r) => r.canonicalId)).toEqual([T, S, A, B]);
  });
});

// =============================================================================
// Suíte B — candidato do grafo genuinamente FORA do top-K denso (exige >
// FUSION_DENSE_K=50 versos qualificados no corpus para que o corte do LIMIT
// realmente exclua o alvo do ranking denso) — prova a 2ª consulta
// (`scoreVersesByIds`, distância honesta) e o tie-break total
// `(rank_da_semente, hop, canonicalId, translation)` entre candidatos do
// grafo. Suíte separada (banco próprio) para não perturbar a geometria da
// Suíte A.
// =============================================================================

describe.skipIf(!databaseUp)("searchByThemeFused — candidato fora do top-K denso + tie-break total", () => {
  let sql: postgres.Sql;
  let dbName: string;

  const queryVector = angledVector(0);
  const FILLER_COUNT = FUSION_DENSE_K; // exatamente o tamanho do pool denso — T/Y ficam de fora por construção

  // 50 versos "de enchimento", todos EXATAMENTE na direção da query (distância
  // 0, empatados entre si — tie-break por canonical_id, já provado em
  // search-theme.test.ts, não é o foco aqui). "PSA_1_01" (o menor
  // lexicograficamente) é a semente S — sempre rank1, dentro do top-N.
  const fillerIds = Array.from({ length: FILLER_COUNT }, (_, i) => `PSA_1_${String(i + 1).padStart(2, "0")}`);
  const S = fillerIds[0] as string;

  // T (2 traduções) e Y: alcançáveis por S em 1 hop, mas fora do top-50 denso
  // (distância bem maior que os 50 fillers, que empatam em 0). "PSA_2_01" <
  // "PSA_2_02" lexicograficamente ⇒ T deve vencer o tie-break sobre Y.
  const T = "PSA_2_01";
  const Y = "PSA_2_02";
  // W: também alcançável por S, mas só autorizado 'curated' — nunca deve vazar.
  const W = "PSA_2_03";

  beforeAll(async () => {
    const created = await createEphemeralDatabase("n2_outside");
    sql = created.sql;
    dbName = created.dbName;

    for (const id of fillerIds) {
      const [, chapterStr, verseStr] = id.split("_") as [string, string, string];
      await insertVerse(sql, { id, book: "PSA", chapter: Number(chapterStr), verse: Number(verseStr) });
      await insertVerseText(sql, { canonicalId: id, translation: "mock", vector: queryVector, authorizedLevels: ["public"] });
    }

    await insertVerse(sql, { id: T, book: "PSA", chapter: 2, verse: 1 });
    await insertVerseText(sql, { canonicalId: T, translation: "mock-a", vector: angledVector(Math.PI / 2), authorizedLevels: ["public"] });
    await insertVerseText(sql, { canonicalId: T, translation: "mock-b", vector: angledVector(Math.PI / 2), authorizedLevels: ["public"] });

    await insertVerse(sql, { id: Y, book: "PSA", chapter: 2, verse: 2 });
    await insertVerseText(sql, { canonicalId: Y, translation: "mock", vector: angledVector(Math.PI / 2), authorizedLevels: ["public"] });

    await insertVerse(sql, { id: W, book: "PSA", chapter: 2, verse: 3 });
    await insertVerseText(sql, { canonicalId: W, translation: "mock", vector: angledVector(Math.PI / 2), authorizedLevels: ["curated"] });

    await insertEdge(sql, S, T);
    await insertEdge(sql, S, Y);
    await insertEdge(sql, S, W);
  }, 60_000);

  afterAll(async () => {
    await dropEphemeralDatabase(sql, dbName);
  }, 30_000);

  it("busca densa pura (limit=FUSION_DENSE_K) nunca inclui T/Y/W — todos fora do top-K por construção", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const dense = await searchByTheme(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K,
    });
    expect(dense).toHaveLength(FUSION_DENSE_K);
    expect(dense.some((r) => r.canonicalId === T || r.canonicalId === Y || r.canonicalId === W)).toBe(false);
  });

  it("fusão: T/Y aparecem no resultado (pontuados pela 2ª consulta) DEPOIS de todos os 50 fillers densos", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K + 10,
    });

    const ids = fused.map((r) => `${r.canonicalId}/${r.translation}`);
    // Os 50 fillers ocupam as 50 primeiras posições (score puramente denso).
    expect(fused.slice(0, FUSION_DENSE_K).every((r) => fillerIds.includes(r.canonicalId))).toBe(true);
    // Depois deles vêm as linhas do grafo, na ordem do tie-break total
    // (rank_da_semente, hop, canonicalId, translation): T antes de Y
    // (PSA_2_01 < PSA_2_02), e dentro de T, mock-a antes de mock-b.
    expect(ids.slice(FUSION_DENSE_K)).toEqual([`${T}/mock-a`, `${T}/mock-b`, `${Y}/mock`]);
  });

  it("distância honesta: a linha de T/Y no resultado fundido é a distância REAL (não inventada)", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K + 10,
    });

    const expectedDistance = 1 - Math.cos(Math.PI / 2); // = 1 (ângulo reto)
    const tRow = fused.find((r) => r.canonicalId === T && r.translation === "mock-a");
    expect(tRow).toBeDefined();
    expect(tRow?.distance).toBeCloseTo(expectedDistance, 6);
  });

  it("hard filter preservado: W (só 'curated', alcançável por S) nunca vaza para 'public'", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const fused = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K + 10,
    });
    expect(fused.some((r) => r.canonicalId === W)).toBe(false);
  });

  it("determinismo: a mesma fusão 2× (com candidatos fora do top-K) devolve resultado byte-idêntico", async () => {
    const { embedder } = makeFixedQueryEmbedder(queryVector);
    const first = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K + 10,
    });
    const second = await searchByThemeFused(sql, embedder, "consulta sintética", {
      user: makeUser(["public"]),
      limit: FUSION_DENSE_K + 10,
    });
    expect(second).toEqual(first);
  });
});
