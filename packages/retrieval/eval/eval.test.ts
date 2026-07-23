import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RetrievalService, ThemeSearchOptions, ThemeSearchResult, User } from "@bereia/core";
import { PgRetrieval, type QueryEmbedder } from "@bereia/retrieval";
import { DEFAULT_EVAL_USER, runEval } from "./harness.js";
import { parseEvalCasesJsonl, type EvalCase } from "./schema.js";

/**
 * Ancorado no comando de aceite do N8 (plano §7, linha N8 — O GATE):
 * `skipIf(!DATABASE_URL)`: cada pergunta-ouro do mock passa o critério de
 * cobertura; determinismo (2× idêntico) verde; snapshot estável entre runs.
 *
 * Duas camadas de prova, como o resto do pacote:
 * 1. **Unit do critério** (sem rede/DB): `RetrievalService` FAKE, cobre
 *    cobertura/`strict`, agregação e determinismo do próprio `runEval`.
 * 2. **Integração `skipIf(!DATABASE_URL)`**: banco de teste EFÊMERO (padrão
 *    N3/N6) semeado com uma fixture AUTOCONSISTENTE — vetores sintéticos
 *    construídos para que CADA pergunta do `perguntas-ouro.mock.jsonl` REAL
 *    passe o critério contra esse banco (o embedder fake mapeia cada texto
 *    de query mock a um vetor que ranqueia os `expectedIds` do caso no
 *    topo). Isso prova o harness de PONTA A PONTA (parser N7 + `PgRetrieval`
 *    N6 + `runEval` N8) sem depender de embeddings reais do corpus — as
 *    perguntas mock são placeholders ESTRUTURAIS, o teste não afirma nada
 *    teológico (CLAUDE.md §7).
 */

// --- (a) unit do critério — RetrievalService FAKE, sem rede/DB -------------

function makeFakeService(
  search: (query: string, user: User, options?: ThemeSearchOptions) => readonly ThemeSearchResult[],
): RetrievalService {
  return {
    searchByTheme: async (query, user, options) => [...search(query, user, options)],
    getVerse: () => {
      throw new Error("fake: getVerse não implementado — runEval não chama esta operação");
    },
    getExegesis: () => {
      throw new Error("fake: getExegesis não implementado — runEval não chama esta operação");
    },
    getCrossReferences: () => {
      throw new Error("fake: getCrossReferences não implementado — runEval não chama esta operação");
    },
  };
}

function themeResult(canonicalId: string, distance = 0): ThemeSearchResult {
  return { canonicalId, translation: "mock", text: "texto sintético de mock, sem valor teológico", distance };
}

function makeCase(params: {
  id: string;
  query: string;
  expectedIds: readonly string[];
  note: string;
  translation?: string;
  limit?: number;
  strict?: boolean;
}): EvalCase {
  return {
    id: params.id,
    query: params.query,
    limit: params.limit ?? 10,
    strict: params.strict ?? false,
    expectedIds: [...params.expectedIds],
    note: params.note,
    ...(params.translation !== undefined ? { translation: params.translation } : {}),
  };
}

describe("runEval — critério de cobertura (fake service, sem DB)", () => {
  it("cobertura: passa quando todos expectedIds estão no topN, em qualquer ordem", async () => {
    const evalCase = makeCase({
      id: "caso-cobertura-ok",
      query: "mock: busca a",
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
      limit: 5,
    });
    const service = makeFakeService(() => [themeResult("EXO_1_1"), themeResult("GEN_1_2"), themeResult("GEN_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases).toEqual([
      {
        id: "caso-cobertura-ok",
        passed: true,
        criterion: "coverage",
        missing: [],
        ranking: ["EXO_1_1", "GEN_1_2", "GEN_1_1"],
      },
    ]);
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it("cobertura: falha e lista os expectedIds ausentes em `missing`", async () => {
    const evalCase = makeCase({
      id: "caso-cobertura-falha",
      query: "mock: busca b",
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
      limit: 3,
    });
    const service = makeFakeService(() => [themeResult("EXO_1_1"), themeResult("GEN_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases[0]).toEqual({
      id: "caso-cobertura-falha",
      passed: false,
      criterion: "coverage",
      missing: ["GEN_1_2"],
      ranking: ["EXO_1_1", "GEN_1_1"],
    });
    expect(report).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  it("cobertura: `ranking`/critério de missing respeitam `limit` mesmo se o service devolver mais linhas", async () => {
    const evalCase = makeCase({
      id: "caso-cobertura-trunca",
      query: "mock: busca trunca",
      expectedIds: ["GEN_1_1"],
      note: "placeholder estrutural",
      limit: 1,
    });
    // Service "mal-comportado" que ignora `limit` — o harness trunca por conta própria.
    const service = makeFakeService(() => [themeResult("EXO_1_1"), themeResult("GEN_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases[0]).toEqual({
      id: "caso-cobertura-trunca",
      passed: false,
      criterion: "coverage",
      missing: ["GEN_1_1"],
      ranking: ["EXO_1_1"],
    });
  });
});

describe("runEval — critério strict (fake service, sem DB)", () => {
  it("strict: passa quando expectedIds são EXATAMENTE o prefixo, na ordem", async () => {
    const evalCase = makeCase({
      id: "caso-strict-ok",
      query: "mock: busca c",
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
      strict: true,
      limit: 5,
    });
    const service = makeFakeService(() => [themeResult("GEN_1_1"), themeResult("GEN_1_2"), themeResult("EXO_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases[0]).toEqual({
      id: "caso-strict-ok",
      passed: true,
      criterion: "strict",
      missing: [],
      ranking: ["GEN_1_1", "GEN_1_2", "EXO_1_1"],
    });
  });

  it("strict: falha por ORDEM mesmo com todos expectedIds presentes (missing vazio, passed false)", async () => {
    const evalCase = makeCase({
      id: "caso-strict-ordem",
      query: "mock: busca d",
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
      strict: true,
      limit: 5,
    });
    const service = makeFakeService(() => [themeResult("GEN_1_2"), themeResult("GEN_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases[0]).toEqual({
      id: "caso-strict-ordem",
      passed: false,
      criterion: "strict",
      missing: [],
      ranking: ["GEN_1_2", "GEN_1_1"],
    });
  });

  it("strict: falha por AUSÊNCIA (mesmo `missing` preenchido que a cobertura teria)", async () => {
    const evalCase = makeCase({
      id: "caso-strict-ausente",
      query: "mock: busca e",
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
      strict: true,
      limit: 5,
    });
    const service = makeFakeService(() => [themeResult("GEN_1_1")]);

    const report = await runEval(service, [evalCase]);

    expect(report.cases[0]).toEqual({
      id: "caso-strict-ausente",
      passed: false,
      criterion: "strict",
      missing: ["GEN_1_2"],
      ranking: ["GEN_1_1"],
    });
  });
});

describe("runEval — agregação e determinismo do report", () => {
  it("total/passed/failed refletem os casos e `report.cases` preserva a ordem de entrada", async () => {
    const caseA = makeCase({ id: "a", query: "mock: a", expectedIds: ["GEN_1_1"], note: "placeholder" });
    const caseB = makeCase({ id: "b", query: "mock: b", expectedIds: ["EXO_1_1"], note: "placeholder" });
    const caseC = makeCase({ id: "c", query: "mock: c", expectedIds: ["LEV_1_1"], note: "placeholder" });
    const service = makeFakeService((query) => {
      if (query === "mock: a") return [themeResult("GEN_1_1")];
      if (query === "mock: b") return []; // caso B falha de propósito
      if (query === "mock: c") return [themeResult("LEV_1_1")];
      throw new Error(`query inesperada no fake: ${query}`);
    });

    const report = await runEval(service, [caseA, caseB, caseC]);

    expect(report.cases.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(report).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it("2 execuções idênticas do mesmo `runEval` produzem reports estruturalmente iguais (determinismo)", async () => {
    const evalCase = makeCase({ id: "caso-determinismo", query: "mock: busca f", expectedIds: ["GEN_1_1"], note: "placeholder" });
    const service = makeFakeService(() => [themeResult("GEN_1_1"), themeResult("EXO_1_1")]);

    const first = await runEval(service, [evalCase]);
    const second = await runEval(service, [evalCase]);

    expect(second).toEqual(first);
  });
});

describe("runEval — injeção de usuário e repasse de opções", () => {
  it("usa `DEFAULT_EVAL_USER` quando `options.user` não é passado", async () => {
    let capturedUser: User | undefined;
    const service = makeFakeService((_query, user) => {
      capturedUser = user;
      return [];
    });

    await runEval(service, [makeCase({ id: "x", query: "mock: y", expectedIds: ["GEN_1_1"], note: "z" })]);

    expect(capturedUser).toEqual(DEFAULT_EVAL_USER);
  });

  it("aceita `options.user` customizado e repassa ao service", async () => {
    const customUser: User = { id: "usuario-mock-restrito", accessLevels: ["public"] };
    let capturedUser: User | undefined;
    const service = makeFakeService((_query, user) => {
      capturedUser = user;
      return [];
    });

    await runEval(service, [makeCase({ id: "x", query: "mock: y", expectedIds: ["GEN_1_1"], note: "z" })], {
      user: customUser,
    });

    expect(capturedUser).toEqual(customUser);
  });

  it("repassa `translation`/`limit` do caso para `searchByTheme` (translation ausente não vira chave `undefined`)", async () => {
    let capturedOptions: ThemeSearchOptions | undefined;
    const service = makeFakeService((_query, _user, options) => {
      capturedOptions = options;
      return [];
    });

    await runEval(service, [makeCase({ id: "x", query: "mock: y", limit: 7, expectedIds: ["GEN_1_1"], note: "z" })]);
    expect(capturedOptions).toEqual({ limit: 7 });

    await runEval(service, [
      makeCase({ id: "x2", query: "mock: y2", translation: "KJV", limit: 7, expectedIds: ["GEN_1_1"], note: "z" }),
    ]);
    expect(capturedOptions).toEqual({ translation: "KJV", limit: 7 });
  });
});

// --- (b) integração de ponta a ponta com o mock REAL (skipIf sem DATABASE_URL) ---

const DIMENSIONS = 1024;

function zeroVector(): number[] {
  return new Array(DIMENSIONS).fill(0);
}

function axisVector(index: number): number[] {
  const v = zeroVector();
  v[index] = 1;
  return v;
}

/**
 * Vetor de query com pesos DECRESCENTES nos eixos de `axes`, na ordem dada:
 * gera distância cosseno estritamente CRESCENTE na mesma ordem dos eixos
 * (prova o critério `strict` quando `axes.length > 1`) e SEMPRE menor que a
 * distância a qualquer eixo ortogonal fora de `axes` (que vale exatamente 1)
 * — é o que dá autoconsistência à fixture: cada query mock "aponta" só para
 * os eixos dos seus próprios `expectedIds`.
 */
function rankedVector(axes: readonly number[]): number[] {
  const v = zeroVector();
  axes.forEach((axisIndex, position) => {
    v[axisIndex] = 1 / (position + 1);
  });
  return v;
}

function formatVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = path.join(HERE, "perguntas-ouro.mock.jsonl");
const MIGRATIONS_DIR = path.resolve(HERE, "../../core/drizzle");

function readMigration(fileName: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

/**
 * Mapa QUERY (texto exato do mock) → eixos dos `expectedIds` daquela query,
 * na ORDEM em que aparecem no caso. Espelha `perguntas-ouro.mock.jsonl`
 * (N7) — se o mock ganhar/perder um caso, este mapa precisa acompanhar (o
 * teste abaixo explode com mensagem clara se a query não bater).
 */
const AXIS_BY_CANONICAL_ID: Record<string, number> = {
  GEN_1_1: 0,
  GEN_1_2: 1,
  EXO_1_1: 2,
  LEV_1_1: 3,
  NUM_1_1: 4,
  DEU_1_1: 5,
  JOS_1_1: 6,
};
/** Distrator: mesma `translation` (`KJV`) do caso `mock-tema-b`, mas fora de qualquer `expectedIds`. */
const DISTRACTOR_KJV_AXIS = 7;
const DISTRACTOR_KJV_ID = "JDG_1_1";

const QUERY_VECTORS: Record<string, readonly number[]> = {
  "mock: tema sintético A": rankedVector([AXIS_BY_CANONICAL_ID["GEN_1_1"]!, AXIS_BY_CANONICAL_ID["GEN_1_2"]!]),
  "mock: tema sintético B": rankedVector([AXIS_BY_CANONICAL_ID["EXO_1_1"]!]),
  "mock: tema sintético C": rankedVector([
    AXIS_BY_CANONICAL_ID["LEV_1_1"]!,
    AXIS_BY_CANONICAL_ID["NUM_1_1"]!,
    AXIS_BY_CANONICAL_ID["DEU_1_1"]!,
  ]),
  "mock: tema sintético D": rankedVector([AXIS_BY_CANONICAL_ID["JOS_1_1"]!]),
};

/** Embedder fake: só conhece as queries do mock — qualquer outra explode (fixture não é genérica de propósito). */
function makeMockAlignedEmbedder(): QueryEmbedder {
  return {
    async embedQuery(text: string) {
      const vector = QUERY_VECTORS[text];
      if (vector === undefined) {
        throw new Error(
          `embedder fake do eval.test.ts: query "${text}" não está mapeada em QUERY_VECTORS — atualize o mapa se ` +
            "o mock ganhou/perdeu um caso",
        );
      }
      return [...vector];
    },
  };
}

describe.skipIf(!databaseUp)("eval.test — harness de ponta a ponta contra o mock REAL (banco de teste efêmero)", () => {
  let testDatabaseUrl: string;
  let testDbName: string;
  let sql: ReturnType<typeof postgres>;
  let service: RetrievalService;
  let mockCases: EvalCase[];

  beforeAll(async () => {
    mockCases = parseEvalCasesJsonl(readFileSync(MOCK_PATH, "utf8"));

    testDbName = `bereia_test_n8_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
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

    // --- fixture sintética AUTOCONSISTENTE (mock, marcada — zero teologia) ---
    // Um verso por `expectedId` que aparece no mock, mais 1 distrator KJV
    // (`JDG_1_1`) para o caso `strict` (mock-tema-b) não ser trivial (mais de
    // 1 candidato na mesma `translation`). Cada verso mora num eixo próprio
    // — ortogonais entre si — então o vetor de cada query (`rankedVector`,
    // acima) fica geometricamente mais perto dos SEUS `expectedIds` que de
    // qualquer outro verso da fixture, por construção.
    const canonicalIds = [...Object.keys(AXIS_BY_CANONICAL_ID), DISTRACTOR_KJV_ID];
    const canonicalValues = canonicalIds
      .map((id) => {
        const [book, chapter, verse] = id.split("_");
        return `('${id}', '${book}', ${chapter}, ${verse}, 'protestant', NULL)`;
      })
      .join(",\n        ");
    await sql.unsafe(`
      INSERT INTO canonical_verses (id, book, chapter, verse, canon_status, theological_category)
      VALUES
        ${canonicalValues}
    `);

    const publicLiteral = formatTextArrayLiteral(["public"]);
    for (const [canonicalId, axis] of Object.entries(AXIS_BY_CANONICAL_ID)) {
      const vectorLiteral = formatVectorLiteral(axisVector(axis));
      // EXO_1_1 é o único verso do caso `mock-tema-b` (translation="KJV");
      // os demais ficam em `translation="mock"` (os outros casos não filtram tradução).
      const translation = canonicalId === "EXO_1_1" ? "KJV" : "mock";
      await sql`
        INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
        VALUES (
          ${canonicalId}, ${translation},
          ${`texto sintético de mock (${canonicalId}), sem valor teológico`},
          ${vectorLiteral}::vector, ${publicLiteral}::text[]
        )
      `;
    }
    // Distrator: mesma translation="KJV" do caso strict, eixo distinto — prova
    // que `EXO_1_1` fica em 1º no prefixo por distância, não por ser o único candidato.
    const distractorVectorLiteral = formatVectorLiteral(axisVector(DISTRACTOR_KJV_AXIS));
    await sql`
      INSERT INTO verse_texts (canonical_id, translation, text, embedding, authorized_levels)
      VALUES (
        ${DISTRACTOR_KJV_ID}, 'KJV',
        ${`texto sintético distrator de mock (${DISTRACTOR_KJV_ID}), sem valor teológico`},
        ${distractorVectorLiteral}::vector, ${publicLiteral}::text[]
      )
    `;

    service = new PgRetrieval({ sql, embedder: makeMockAlignedEmbedder() });
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

  it("cada pergunta-ouro do mock passa o critério de cobertura/strict contra a fixture autoconsistente", async () => {
    const report = await runEval(service, mockCases);

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
    expect(report.total).toBe(mockCases.length);
    for (const caseReport of report.cases) {
      expect(caseReport.passed).toBe(true);
      expect(caseReport.missing).toEqual([]);
    }
  });

  it("determinismo: rodar o eval 2× contra o Postgres real devolve reports estruturalmente idênticos", async () => {
    const first = await runEval(service, mockCases);
    const second = await runEval(service, mockCases);

    expect(second).toEqual(first);
  });

  it("snapshot estável: o report do mock pina o formato (id/passed/criterion/missing/ranking + agregado)", async () => {
    const report = await runEval(service, mockCases);

    expect(report).toMatchInlineSnapshot(`
      {
        "cases": [
          {
            "criterion": "coverage",
            "id": "mock-tema-a",
            "missing": [],
            "passed": true,
            "ranking": [
              "GEN_1_1",
              "GEN_1_2",
              "DEU_1_1",
              "EXO_1_1",
              "JDG_1_1",
              "JOS_1_1",
              "LEV_1_1",
              "NUM_1_1",
            ],
          },
          {
            "criterion": "strict",
            "id": "mock-tema-b",
            "missing": [],
            "passed": true,
            "ranking": [
              "EXO_1_1",
              "JDG_1_1",
            ],
          },
          {
            "criterion": "coverage",
            "id": "mock-tema-c",
            "missing": [],
            "passed": true,
            "ranking": [
              "LEV_1_1",
              "NUM_1_1",
              "DEU_1_1",
              "EXO_1_1",
              "GEN_1_1",
              "GEN_1_2",
              "JDG_1_1",
              "JOS_1_1",
            ],
          },
          {
            "criterion": "coverage",
            "id": "mock-tema-d",
            "missing": [],
            "passed": true,
            "ranking": [
              "JOS_1_1",
              "DEU_1_1",
              "EXO_1_1",
            ],
          },
        ],
        "failed": 0,
        "passed": 4,
        "total": 4,
      }
    `);
  });
});

if (!databaseUp) {
  // eslint-disable-next-line no-console
  console.warn(
    "eval.test.ts: integração contra o mock pulada — DATABASE_URL não respondeu (suba o compose antes de esperar " +
      "verde aqui). Nunca verde-falso.",
  );
}
