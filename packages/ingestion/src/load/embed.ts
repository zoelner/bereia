/**
 * Embed batch (N9 do plano de fechamento da Fase 1, §3.4). Lê `verse_texts/*.jsonl`
 * do JSONL canônico, envia os textos em lotes ao sidecar de embedding (BGE-M3,
 * `embedder/main.py`) e grava o JSONL DERIVADO `data/derived/embeddings-{revision}.jsonl`
 * — fora do Git (ADR-006), reconstruível a qualquer momento a partir do canônico.
 *
 * Determinismo por build (ADR-005): vetores só são reprodutíveis para a MESMA
 * combinação modelo+revisão HF+deps do container do sidecar. Por isso, ANTES de
 * qualquer chamada a `/embed`, este módulo confere `GET /health` contra a
 * revisão esperada (pinada em `EXPECTED_HF_REVISION`) e ABORTA com erro claro
 * se divergir — nunca grava vetores de um build não rastreado. O carimbo
 * `embeddingModel` gravado em cada linha (OQ-8) é `"${model}@${revision}"`,
 * lido diretamente da resposta do `/health` (não hardcoded), mas a TRAVA usa a
 * constante pinada — ou seja: o build tem que bater com o que este código
 * conhece, não o inverso.
 *
 * Ordem de saída: as linhas de `verse_texts` são reunidas de TODOS os arquivos
 * particionados por livro e reordenadas com o comparador total do N4
 * (`compareVerseText`) — não confia na ordem de `readdirSync` (não é a ordem
 * canônica de livro) nem na ordem de chegada dos lotes. Cada embedding sai na
 * MESMA posição relativa do `verse_texts` correspondente.
 *
 * Injeção de dependência (`EmbedderClient`): a orquestração (`runEmbedBatch`)
 * não chama `fetch` diretamente — recebe um cliente. Isso permite testar a
 * trava de revisão e a lógica de determinismo/ordenação sem rede real (ver
 * `embed.test.ts`), reservando a suíte com sidecar real para o hash de
 * regressão e a integração fim-a-fim.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalIdSchema } from "@bereia/core";
import type { VerseText } from "@bereia/core";
import { compareVerseText, sortDeterministic } from "./order.js";
import { readJsonl, readVerseTexts, writeJsonl } from "./jsonl.js";

// --- Trava de revisão (ADR-005) --------------------------------------------

/** Nome do modelo pinado — deve bater com `MODEL_NAME` do sidecar (`embedder/main.py`). */
export const EXPECTED_MODEL_NAME = "BAAI/bge-m3";
/** Revisão HF pinada — deve bater com `HF_REVISION` do sidecar. */
export const EXPECTED_HF_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
/** Carimbo completo esperado (OQ-8): `"${MODEL_NAME}@${HF_REVISION}"`. */
export const EXPECTED_EMBEDDING_MODEL_STAMP = `${EXPECTED_MODEL_NAME}@${EXPECTED_HF_REVISION}`;

/** Tamanho de lote default — abaixo do teto do sidecar (`EmbedRequest.texts` máx. 512). */
export const DEFAULT_BATCH_SIZE = 32;
/** Teto de lote imposto pelo sidecar (`embedder/main.py`, `Field(max_length=512)`). */
export const MAX_BATCH_SIZE = 512;

const healthResponseSchema = z.object({
  status: z.string(),
  model: z.string(),
  revision: z.string(),
});
export type EmbedderHealth = z.infer<typeof healthResponseSchema>;

const embedResponseSchema = z.object({
  vectors: z.array(z.array(z.number())).min(1),
  model: z.string(),
  revision: z.string(),
  dimensions: z.number().int().positive(),
});
export type EmbedResponse = z.infer<typeof embedResponseSchema>;

/** Dimensão do BGE-M3 pinado — invariante do espaço vetorial compartilhado (schema `vector(1024)`). */
export const EXPECTED_EMBEDDING_DIMENSIONS = 1024;

// Trava da fronteira HTTP real: o `EmbedderClient` injetável permanece
// dimensão-agnóstico (fixtures unitárias), mas nenhum vetor fora de 1024 pode
// entrar em produção — um sidecar com build de dimensão errada explode AQUI,
// não só no load do Postgres.
const httpEmbedResponseSchema = embedResponseSchema.superRefine((res, ctx) => {
  if (res.dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `embed: sidecar reporta dimensions=${res.dimensions}, esperado ` +
        `${EXPECTED_EMBEDDING_DIMENSIONS} (BGE-M3 pinado) — build incompatível com o schema vector(1024)`,
    });
  }
  const bad = res.vectors.findIndex((v) => v.length !== res.dimensions);
  if (bad !== -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `embed: vetor no índice ${bad} tem ${res.vectors[bad]?.length} dimensões, ` +
        `divergindo do dimensions=${res.dimensions} reportado pelo sidecar`,
    });
  }
});

/**
 * Confere `health` contra o modelo/revisão pinados (ADR-005). Explode com
 * mensagem clara em PT se divergir — é a trava que impede gravar vetores de
 * um build de sidecar não rastreado.
 */
export function assertExpectedRevision(health: EmbedderHealth): void {
  if (health.model !== EXPECTED_MODEL_NAME || health.revision !== EXPECTED_HF_REVISION) {
    throw new Error(
      "embed: build do sidecar de embedding diverge do esperado (ADR-005) — " +
        `esperado "${EXPECTED_MODEL_NAME}@${EXPECTED_HF_REVISION}", ` +
        `recebido "${health.model}@${health.revision}". Vetores de builds diferentes não são ` +
        "comparáveis; re-embed exige bump explícito da revisão pinada neste módulo antes de rodar.",
    );
  }
}

// --- Cliente do sidecar (injetável — ver nota de topo) ----------------------

/** Porta mínima que `runEmbedBatch` precisa do sidecar — real (HTTP) ou fake (testes). */
export interface EmbedderClient {
  health(): Promise<EmbedderHealth>;
  embed(texts: readonly string[]): Promise<EmbedResponse>;
}

/** Timeout do `/health` (checagem rápida): sidecar pendurado vira erro, não hang. */
export const HEALTH_TIMEOUT_MS = 10_000;
/** Timeout de um lote de `/embed` — generoso (BGE-M3 em CPU), mas finito. */
export const EMBED_TIMEOUT_MS = 600_000;

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `embed: falha de rede ao chamar ${url} (timeout ${timeoutMs}ms) — ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`embed: ${url} respondeu HTTP ${response.status} — ${body}`);
  }
  return (await response.json()) as unknown;
}

/** Cliente real via `fetch` nativo do Node — sem dependência HTTP extra. */
export function createHttpEmbedderClient(embedderUrl: string): EmbedderClient {
  return {
    async health() {
      const body = await fetchJson(`${embedderUrl}/health`, HEALTH_TIMEOUT_MS);
      return healthResponseSchema.parse(body);
    },
    async embed(texts) {
      if (texts.length === 0) {
        throw new Error("embed: lote vazio enviado ao sidecar — bug de chamada, não deveria acontecer");
      }
      if (texts.length > MAX_BATCH_SIZE) {
        throw new Error(
          `embed: lote de ${texts.length} textos excede o teto do sidecar (${MAX_BATCH_SIZE}) — ajuste batchSize`,
        );
      }
      const body = await fetchJson(`${embedderUrl}/embed`, EMBED_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      return httpEmbedResponseSchema.parse(body);
    },
  };
}

// --- Leitura de `verse_texts/*.jsonl` ---------------------------------------

/**
 * Lê e reúne TODOS os arquivos `verse_texts/{BOOK}.jsonl` do canônico, na
 * ordem canônica total do N4 (`compareVerseText`) — independe da ordem de
 * `readdirSync` do sistema de arquivos.
 */
export function readAllVerseTexts(canonicalDir: string): VerseText[] {
  const dir = path.join(canonicalDir, "verse_texts");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new Error(
      `embed: não foi possível ler o diretório de verse_texts em ${dir} — ${(error as Error).message}`,
    );
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort(); // ordem de leitura irrelevante — reordenado abaixo
  const all: VerseText[] = [];
  for (const file of files) {
    const content = readFileSync(path.join(dir, file), "utf8");
    all.push(...readVerseTexts(content));
  }
  return sortDeterministic(all, compareVerseText);
}

// --- Linha de saída do derivado ---------------------------------------------

/** `{canonicalId, translation, embedding, embeddingModel}` — NÃO é o schema do canônico (ADR-006: derivado, fora do Git). */
export const embeddingRowSchema = z.object({
  canonicalId: canonicalIdSchema,
  translation: z.string().min(1),
  embedding: z.array(z.number()).min(1),
  embeddingModel: z.string().min(1),
});
export type EmbeddingRow = z.infer<typeof embeddingRowSchema>;

const EMBEDDING_ROW_KEYS = Object.freeze(
  Object.keys(embeddingRowSchema.shape),
) as readonly (keyof EmbeddingRow & string)[];

/** Serializa as linhas do derivado — mesmo writer determinístico do N4 (`writeJsonl`), chaves em ordem fixa. */
export function writeEmbeddingRows(rows: readonly EmbeddingRow[]): string {
  return writeJsonl(rows, EMBEDDING_ROW_KEYS);
}

/** Lê e valida (Zod) um derivado de embeddings já gravado — testes e load a jusante. */
export function readEmbeddingRowsFile(file: string): EmbeddingRow[] {
  return readJsonl(readFileSync(file, "utf8"), embeddingRowSchema);
}

/** Caminho default do derivado (plano §3.4): `data/derived/embeddings-{revision}.jsonl`. */
export function defaultOutFile(dataDir: string, revision: string): string {
  return path.join(dataDir, "derived", `embeddings-${revision}.jsonl`);
}

// --- Orquestração ------------------------------------------------------------

export interface RunEmbedBatchOptions {
  /** Raiz do JSONL canônico (contém `verse_texts/`). */
  canonicalDir: string;
  /** Raiz de dados — usada para o caminho default de saída quando `outFile` não é informado. */
  dataDir: string;
  /** Caminho de saída explícito; default `defaultOutFile(dataDir, revision)`. */
  outFile?: string;
  /** Cliente do sidecar — real (`createHttpEmbedderClient`) ou fake (testes). */
  client: EmbedderClient;
  /** Tamanho de lote — default `DEFAULT_BATCH_SIZE`, teto `MAX_BATCH_SIZE`. */
  batchSize?: number;
}

export interface RunEmbedBatchResult {
  /** Linhas gravadas. Os vetores NÃO ficam em memória — leia do `outFile` (`readEmbeddingRowsFile`). */
  rowCount: number;
  embeddingModel: string;
  outFile: string;
}

/**
 * Roda o pipeline completo: `/health` → trava de revisão (ADR-005) → lê
 * `verse_texts` → embed em lotes → grava o derivado. Explode cedo em
 * qualquer divergência de contrato (revisão, shape de resposta, contagem de
 * vetores por lote).
 *
 * ## Memória e atomicidade
 * O corpus real (93k linhas × 1024 floats) NÃO cabe confortavelmente no heap
 * como string única (~1,9GB serializados — acima do limite de string do V8;
 * causa raiz de um OOM real em produção). A gravação é em STREAMING por lote
 * num `<outFile>.tmp`, com `rename` atômico no fim: falha no meio nunca deixa
 * o caminho final com estado parcial, e os bytes são idênticos aos da
 * serialização única (cada chunk termina em LF — mesmo contrato do writer N4).
 */
export async function runEmbedBatch(options: RunEmbedBatchOptions): Promise<RunEmbedBatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`embed: batchSize deve estar em [1, ${MAX_BATCH_SIZE}], recebido ${batchSize}`);
  }

  const health = await options.client.health();
  assertExpectedRevision(health);
  const embeddingModel = `${health.model}@${health.revision}`;
  const outFile = options.outFile ?? defaultOutFile(options.dataDir, health.revision);

  const verseTexts = readAllVerseTexts(options.canonicalDir);

  mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpFile = `${outFile}.tmp`;
  const fd = openSync(tmpFile, "w");
  let rowCount = 0;
  try {
    for (let start = 0; start < verseTexts.length; start += batchSize) {
      const batch = verseTexts.slice(start, start + batchSize);
      const response = await options.client.embed(batch.map((entry) => entry.text));
      if (response.vectors.length !== batch.length) {
        throw new Error(
          `embed: sidecar devolveu ${response.vectors.length} vetores para um lote de ${batch.length} textos ` +
            `(offset ${start}) — resposta inconsistente, abortando`,
        );
      }
      if (response.model !== health.model || response.revision !== health.revision) {
        throw new Error(
          `embed: resposta de /embed (${response.model}@${response.revision}) divergiu de /health ` +
            `(${health.model}@${health.revision}) a meio da execução — build do sidecar mudou durante o batch`,
        );
      }
      const batchRows: EmbeddingRow[] = [];
      for (let index = 0; index < batch.length; index++) {
        const verseText = batch[index];
        const vector = response.vectors[index];
        if (verseText === undefined || vector === undefined) {
          throw new Error("embed: índice fora de alcance ao parear texto e vetor — bug de batching");
        }
        batchRows.push({
          canonicalId: verseText.canonicalId,
          translation: verseText.translation,
          embedding: vector,
          embeddingModel,
        });
      }
      // Chunk termina em LF (contrato do writeJsonl) → concatenação de chunks
      // é byte-idêntica à serialização única do conjunto completo.
      writeSync(fd, writeEmbeddingRows(batchRows));
      rowCount += batchRows.length;
    }
  } catch (error) {
    closeSync(fd);
    rmSync(tmpFile, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(tmpFile, outFile);

  return { rowCount, embeddingModel, outFile };
}

// --- CLI ----------------------------------------------------------------------

function parseBatchSizeEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`embed: EMBED_BATCH_SIZE inválido: "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const dataDir = process.env["DATA_DIR"] ?? "./data";
  const canonicalDir = process.env["CANONICAL_DIR"] ?? path.join(dataDir, "canonical");
  const embedderUrl = process.env["EMBEDDER_URL"] ?? "http://localhost:8000";
  const outFile = process.env["EMBED_OUT_FILE"];
  const batchSize = parseBatchSizeEnv(process.env["EMBED_BATCH_SIZE"]);

  const client = createHttpEmbedderClient(embedderUrl);
  const result = await runEmbedBatch({
    canonicalDir,
    dataDir,
    client,
    ...(outFile !== undefined ? { outFile } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  });

  // eslint-disable-next-line no-console -- CLI: saída de progresso é o propósito
  console.log(
    `embed: ${result.rowCount} vetores gravados em ${result.outFile} (embeddingModel=${result.embeddingModel})`,
  );
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
