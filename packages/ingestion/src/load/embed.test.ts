import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCanonicalId, type VerseText } from "@bereia/core";
import { writeVerseTexts } from "./jsonl.js";
import {
  DEFAULT_BATCH_SIZE,
  EXPECTED_EMBEDDING_MODEL_STAMP,
  EXPECTED_HF_REVISION,
  EXPECTED_MODEL_NAME,
  MAX_BATCH_SIZE,
  assertExpectedRevision,
  createHttpEmbedderClient,
  defaultOutFile,
  embeddingRowSchema,
  readAllVerseTexts,
  runEmbedBatch,
  readEmbeddingRowsFile,
  writeEmbeddingRows,
  type EmbedderClient,
  type EmbedResponse,
  type EmbedderHealth,
} from "./embed.js";

/**
 * Ancorado em requisito (ADR-008/plano §3.4/§5 linha N9):
 * - UNIT (sem rede): trava de revisão (ADR-005) simulada via `EmbedderClient`
 *   fake — injeção de dependência, NUNCA mock global de `fetch`; ordenação
 *   determinística idêntica à de `verse_texts` (N4); determinismo byte a byte;
 *   batching não reordena; contrato de erro em respostas malformadas do sidecar.
 * - INTEGRAÇÃO (skipIf sem sidecar alcançável em `EMBEDDER_URL`, nunca verde
 *   falso): hash de regressão de um conjunto FIXO de versos (textos literais
 *   da KJV, domínio público) — âncora do build (ADR-005); dimensão 1024.
 *
 * Textos usados nos fixtures são OU (a) placeholders neutros marcados como
 * mock, OU (b) textos literais da KJV (domínio público) nos casos ancorados
 * explicitamente no plano — nunca conteúdo teológico inventado.
 */

// --- helpers --------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bereia-n9-embed-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Grava um fixture `verse_texts/{BOOK}.jsonl` a partir de registros já montados — reusa o writer do N4. */
function writeFixtureVerseTexts(canonicalDir: string, records: readonly VerseText[]): void {
  const dir = path.join(canonicalDir, "verse_texts");
  mkdirSync(dir, { recursive: true });
  const byBook = new Map<string, VerseText[]>();
  for (const record of records) {
    const { book } = parseCanonicalId(record.canonicalId);
    const forBook = byBook.get(book) ?? [];
    forBook.push(record);
    byBook.set(book, forBook);
  }
  for (const [book, forBook] of byBook) {
    const filePath = path.join(dir, `${book}.jsonl`);
    writeFileSync(filePath, writeVerseTexts(forBook));
  }
}

function mockVerseText(canonicalId: string, translation: string, text: string): VerseText {
  return {
    canonicalId,
    translation,
    text,
    embeddingModel: null,
    thematicTags: [],
    culturalContext: null,
    humanReviewed: false,
    reviewedBy: null,
    authorizedLevels: ["public"],
  };
}

/** Vetor determinístico e puro (função do texto) — SEM chamada de rede. */
function fakeVector(text: string, dimensions: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    let acc = 0;
    for (let c = 0; c < text.length; c++) acc += text.charCodeAt(c) * (i + 1) * (c + 1);
    out.push(Number(((acc % 9973) / 9973).toFixed(6)));
  }
  return out;
}

interface FakeClientOptions {
  model?: string;
  revision?: string;
  dimensions?: number;
  /** Registra os lotes efetivamente enviados a `/embed` — usado para provar batching. */
  calls?: string[][];
  /** Override total da resposta de `/embed` — usado para simular contratos quebrados. */
  embedResponseOverride?: (texts: readonly string[]) => EmbedResponse;
}

function makeFakeClient(options: FakeClientOptions = {}): EmbedderClient {
  const model = options.model ?? EXPECTED_MODEL_NAME;
  const revision = options.revision ?? EXPECTED_HF_REVISION;
  const dimensions = options.dimensions ?? 4;
  return {
    health: (): Promise<EmbedderHealth> => Promise.resolve({ status: "ok", model, revision }),
    embed: (texts: readonly string[]): Promise<EmbedResponse> => {
      options.calls?.push([...texts]);
      if (options.embedResponseOverride) {
        return Promise.resolve(options.embedResponseOverride(texts));
      }
      return Promise.resolve({
        vectors: texts.map((text) => fakeVector(text, dimensions)),
        model,
        revision,
        dimensions,
      });
    },
  };
}

// --- unit: trava de revisão (ADR-005) --------------------------------------

describe("trava de revisão do sidecar (ADR-005)", () => {
  it("aceita silenciosamente quando model+revision batem com o esperado", () => {
    expect(() =>
      assertExpectedRevision({ status: "ok", model: EXPECTED_MODEL_NAME, revision: EXPECTED_HF_REVISION }),
    ).not.toThrow();
  });

  it("explode quando a revisão diverge", () => {
    expect(() =>
      assertExpectedRevision({ status: "ok", model: EXPECTED_MODEL_NAME, revision: "0000000000000000000000000000000000000000" }),
    ).toThrow(/ADR-005|revis/i);
  });

  it("explode quando o nome do modelo diverge", () => {
    expect(() =>
      assertExpectedRevision({ status: "ok", model: "outro/modelo", revision: EXPECTED_HF_REVISION }),
    ).toThrow(/ADR-005|modelo|model/i);
  });

  it("runEmbedBatch aborta ANTES de chamar /embed quando a revisão diverge (fixture/injeção, sem mock de rede global)", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, [mockVerseText("GEN_1_1", "MOCK", "texto placeholder mock")]);

    const calls: string[][] = [];
    const client = makeFakeClient({ revision: "revisao-divergente-simulada", calls });

    await expect(runEmbedBatch({ canonicalDir, dataDir, client })).rejects.toThrow(/ADR-005/);
    expect(calls).toEqual([]); // /embed NUNCA foi chamado — a trava aborta antes
  });
});

// --- unit: ordenação, determinismo e batching (fake client, sem rede) ------

describe("runEmbedBatch — ordenação, determinismo e batching (fake client)", () => {
  // Livros deliberadamente fora de ordem alfabética E fora da ordem canônica na
  // gravação dos arquivos-fixture (GEN < JHN < PSA alfabeticamente, mas a ordem
  // canônica do cânon é GEN, PSA, JHN — prova que a ordenação NÃO depende de
  // readdirSync nem da ordem alfabética).
  const fixtures: VerseText[] = [
    mockVerseText("JHN_1_1", "KJV", "texto mock João 1:1"),
    mockVerseText("GEN_1_1", "KJV", "texto mock Gênesis 1:1"),
    mockVerseText("PSA_23_1", "KJV", "texto mock Salmo 23:1"),
    mockVerseText("GEN_1_1", "WEB", "texto mock Gênesis 1:1 (outra tradução)"),
  ];

  it("saída ordenada pela ordem canônica total do N4 (compareVerseText), não por readdir/alfabética", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, fixtures);

    const client = makeFakeClient();
    const outFile = path.join(dataDir, "out.jsonl");
    await runEmbedBatch({ canonicalDir, dataDir, client, outFile });

    const rows = readEmbeddingRowsFile(outFile);
    expect(rows.map((r) => `${r.canonicalId}:${r.translation}`)).toEqual([
      "GEN_1_1:KJV",
      "GEN_1_1:WEB",
      "PSA_23_1:KJV",
      "JHN_1_1:KJV",
    ]);
  });

  it("carimba embeddingModel = OQ-8 (\"${MODEL_NAME}@${HF_REVISION}\") em toda linha", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, fixtures);
    const client = makeFakeClient();
    const outFile = path.join(dataDir, "out.jsonl");
    const result = await runEmbedBatch({ canonicalDir, dataDir, client, outFile });

    expect(result.embeddingModel).toBe(EXPECTED_EMBEDDING_MODEL_STAMP);
    for (const row of readEmbeddingRowsFile(outFile)) {
      expect(row.embeddingModel).toBe(EXPECTED_EMBEDDING_MODEL_STAMP);
      expect(() => embeddingRowSchema.parse(row)).not.toThrow();
    }
  });

  it("respeita batchSize (múltiplos lotes) sem reordenar nem perder linhas", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, fixtures);

    const calls: string[][] = [];
    const client = makeFakeClient({ calls });
    const outFile = path.join(dataDir, "out.jsonl");
    const result = await runEmbedBatch({
      canonicalDir,
      dataDir,
      client,
      batchSize: 2,
      outFile,
    });

    expect(calls.map((batch) => batch.length)).toEqual([2, 2]); // 4 linhas / batchSize 2 = 2 lotes
    expect(result.rowCount).toBe(4);
    expect(readEmbeddingRowsFile(outFile).map((r) => `${r.canonicalId}:${r.translation}`)).toEqual([
      "GEN_1_1:KJV",
      "GEN_1_1:WEB",
      "PSA_23_1:KJV",
      "JHN_1_1:KJV",
    ]);
  });

  it("mesma entrada, duas execuções → arquivo de saída byte a byte idêntico", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, fixtures);

    const outA = path.join(dataDir, "out-a.jsonl");
    const outB = path.join(dataDir, "out-b.jsonl");
    await runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient(), outFile: outA });
    await runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient(), outFile: outB });

    const contentA = readFileSync(outA, "utf8");
    const contentB = readFileSync(outB, "utf8");
    expect(contentA).toBe(contentB);
    expect(contentA.length).toBeGreaterThan(0);
    expect(contentA.endsWith("\n")).toBe(true);
  });

  it("grava no caminho default data/derived/embeddings-{revision}.jsonl quando outFile não é informado", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, [mockVerseText("GEN_1_1", "KJV", "texto mock")]);

    const result = await runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient() });
    expect(result.outFile).toBe(defaultOutFile(dataDir, EXPECTED_HF_REVISION));
    expect(readFileSync(result.outFile, "utf8")).toContain("GEN_1_1");
  });

  it("explode se o sidecar devolver contagem de vetores diferente do lote (contrato quebrado)", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, [mockVerseText("GEN_1_1", "KJV", "a"), mockVerseText("GEN_1_2", "KJV", "b")]);

    const client = makeFakeClient({
      embedResponseOverride: () => ({
        vectors: [[0.1, 0.2]], // 1 vetor para 2 textos — inconsistente
        model: EXPECTED_MODEL_NAME,
        revision: EXPECTED_HF_REVISION,
        dimensions: 2,
      }),
    });

    await expect(runEmbedBatch({ canonicalDir, dataDir, client })).rejects.toThrow(/vetores/);
  });

  it("explode se o diretório verse_texts/ não existir", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical-inexistente");
    await expect(runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient() })).rejects.toThrow(
      /verse_texts/,
    );
  });

  it("rejeita batchSize fora de [1, MAX_BATCH_SIZE]", async () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, [mockVerseText("GEN_1_1", "KJV", "a")]);
    await expect(
      runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient(), batchSize: MAX_BATCH_SIZE + 1 }),
    ).rejects.toThrow(/batchSize/);
    await expect(runEmbedBatch({ canonicalDir, dataDir, client: makeFakeClient(), batchSize: 0 })).rejects.toThrow(
      /batchSize/,
    );
  });
});

describe("readAllVerseTexts / writeEmbeddingRows — unidades auxiliares", () => {
  it("readAllVerseTexts reúne múltiplos arquivos de livro na ordem canônica", () => {
    const dataDir = makeTmpDir();
    const canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, [
      mockVerseText("JHN_1_1", "KJV", "x"),
      mockVerseText("GEN_1_1", "KJV", "y"),
    ]);
    const all = readAllVerseTexts(canonicalDir);
    expect(all.map((v) => v.canonicalId)).toEqual(["GEN_1_1", "JHN_1_1"]);
  });

  it("writeEmbeddingRows produz JSONL com chaves na ordem fixa e round-trip via schema", () => {
    const content = writeEmbeddingRows([
      { canonicalId: "GEN_1_1", translation: "KJV", embedding: [0.1, 0.2], embeddingModel: EXPECTED_EMBEDDING_MODEL_STAMP },
    ]);
    expect(content).toBe(
      `{"canonicalId":"GEN_1_1","translation":"KJV","embedding":[0.1,0.2],"embeddingModel":"${EXPECTED_EMBEDDING_MODEL_STAMP}"}\n`,
    );
    expect(() => embeddingRowSchema.parse(JSON.parse(content.trim()))).not.toThrow();
  });

  it("DEFAULT_BATCH_SIZE está dentro do teto do sidecar", () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_BATCH_SIZE).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });
});

// --- integração real — sidecar de embedding (skipIf inalcançável) ---------

/**
 * Sonda `${EMBEDDER_URL}/health` uma única vez (top-level await, ESM) —
 * `skipIf` quando o sidecar não está de pé, NUNCA verde falso (ADR-006/008).
 */
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

const EMBEDDER_URL = process.env["EMBEDDER_URL"] ?? "http://localhost:8000";
const embedderUp = await probeEmbedderUp(EMBEDDER_URL);

/**
 * Hash de regressão (ADR-005): conjunto FIXO de versos, textos literais da
 * KJV (domínio público — Gn 1:1, Jo 1:1, Sl 23:1), serializados
 * deterministicamente (bytes do JSONL escrito) e resumidos em sha256. Pinado
 * uma vez contra o build real do sidecar; qualquer mudança de revisão/deps
 * quebra este teste ANTES de silenciosamente derivar dado divergente.
 */
const REGRESSION_FIXTURE: readonly VerseText[] = [
  mockVerseText("GEN_1_1", "KJV", "In the beginning God created the heaven and the earth."),
  mockVerseText("JHN_1_1", "KJV", "In the beginning was the Word, and the Word was with God, and the Word was God."),
  mockVerseText("PSA_23_1", "KJV", "The LORD is my shepherd; I shall not want."),
];

/**
 * Pinado rodando `pnpm --filter @bereia/ingestion test -- load/embed` contra
 * o sidecar real (`BAAI/bge-m3@5617a9f6…`, ver notas de retorno do nó N9).
 * Reproduz-se com o mesmo hash em qualquer máquina com o MESMO build do
 * sidecar (ADR-005) — se o build mudar (revisão/deps), este teste é a âncora
 * que quebra primeiro.
 */
const REGRESSION_SHA256 = "924f06a5621152236396a77cb960d7879e2852a0753eee64bed07b49414e93ac";

describe.skipIf(!embedderUp)("integração real — sidecar de embedding em EMBEDDER_URL", () => {
  // Dir próprio (NÃO registrado no `tmpDirs` global) — o `afterEach` de topo
  // de arquivo dispara entre os testes das outras `describe`s e apagaria este
  // fixture no meio da suíte de integração, que usa `beforeAll` (montagem
  // única, custo de rede real). Limpeza própria via `afterAll` abaixo.
  let canonicalDir: string;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "bereia-n9-embed-integration-"));
    canonicalDir = path.join(dataDir, "canonical");
    writeFixtureVerseTexts(canonicalDir, REGRESSION_FIXTURE);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("/health expõe o modelo/revisão pinados (ADR-005)", async () => {
    const client = createHttpEmbedderClient(EMBEDDER_URL);
    const health = await client.health();
    expect(health.model).toBe(EXPECTED_MODEL_NAME);
    expect(health.revision).toBe(EXPECTED_HF_REVISION);
    expect(() => assertExpectedRevision(health)).not.toThrow();
  });

  it(
    "hash de regressão do conjunto fixo de versos bate com o pinado; dimensão 1024",
    { timeout: 60_000 },
    async () => {
      const client = createHttpEmbedderClient(EMBEDDER_URL);
      const outFile = path.join(dataDir, "regression.jsonl");
      const result = await runEmbedBatch({ canonicalDir, dataDir, client, outFile });

      expect(result.rowCount).toBe(REGRESSION_FIXTURE.length);
      for (const row of readEmbeddingRowsFile(outFile)) {
        expect(row.embedding).toHaveLength(1024);
      }

      const content = readFileSync(outFile, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(REGRESSION_SHA256);
    },
  );

  it("mesmo conjunto fixo, duas chamadas ao sidecar → vetores byte a byte idênticos (determinismo por build)", async () => {
    const client = createHttpEmbedderClient(EMBEDDER_URL);
    const outA = path.join(dataDir, "det-a.jsonl");
    const outB = path.join(dataDir, "det-b.jsonl");
    await runEmbedBatch({ canonicalDir, dataDir, client, outFile: outA });
    await runEmbedBatch({ canonicalDir, dataDir, client, outFile: outB });
    expect(readFileSync(outA, "utf8")).toBe(readFileSync(outB, "utf8"));
  });
});
