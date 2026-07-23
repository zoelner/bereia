/**
 * Cliente de embedding de QUERY (N2 do plano da Fase 2, §2.4). O `searchByTheme`
 * (N3) precisa transformar o texto da busca no MESMO espaço vetorial dos
 * `verse_texts.embedding` gravados pelo batch de ingestão — senão a distância
 * `<=>` vira ruído, não similaridade (determinismo por build, ADR-005).
 *
 * Este módulo é uma duplicação MÍNIMA e deliberada do thin client HTTP de
 * `packages/ingestion/src/load/embed.ts`: `retrieval` NÃO importa de
 * `ingestion` (adapter→adapter proibido, ADR-007) — promover um
 * `EmbedderClient` compartilhado para `core` é backlog explícito (OQ-7 do
 * plano). As constantes pinadas (`EXPECTED_MODEL_NAME`, `EXPECTED_HF_REVISION`,
 * `EXPECTED_EMBEDDING_DIMENSIONS`) têm os MESMOS valores do ingestion — devem
 * evoluir em conjunto se o build do sidecar mudar.
 *
 * Diferença de forma em relação ao ingestion: aqui o caminho é de LEITURA
 * (uma query por vez, não lote), e a trava de revisão é cacheada por
 * instância — `/health` é conferido uma única vez antes do primeiro
 * `embedQuery`, não a cada chamada (§2.4: "antes de consultar confere
 * `GET /health`").
 */

import { z } from "zod";

// --- Trava de revisão (ADR-005) — mesmos valores pinados do ingestion ------

/** Nome do modelo pinado — deve bater com `MODEL_NAME` do sidecar (`embedder/main.py`). */
export const EXPECTED_MODEL_NAME = "BAAI/bge-m3";
/** Revisão HF pinada — deve bater com `HF_REVISION` do sidecar. */
export const EXPECTED_HF_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
/** Carimbo completo esperado: `"${MODEL_NAME}@${HF_REVISION}"`. */
export const EXPECTED_EMBEDDING_MODEL_STAMP = `${EXPECTED_MODEL_NAME}@${EXPECTED_HF_REVISION}`;
/** Dimensão do BGE-M3 pinado — mesma invariante do schema `vector(1024)`. */
export const EXPECTED_EMBEDDING_DIMENSIONS = 1024;

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

// Trava da fronteira HTTP real: dimensão errada explode AQUI, antes de virar
// parâmetro de uma query SQL contra `vector(1024)`.
const httpEmbedResponseSchema = embedResponseSchema.superRefine((res, ctx) => {
  if (res.dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `embedQuery: sidecar reporta dimensions=${res.dimensions}, esperado ` +
        `${EXPECTED_EMBEDDING_DIMENSIONS} (BGE-M3 pinado) — build incompatível com o schema vector(1024)`,
    });
  }
  const bad = res.vectors.findIndex((v) => v.length !== res.dimensions);
  if (bad !== -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `embedQuery: vetor no índice ${bad} tem ${res.vectors[bad]?.length} dimensões, ` +
        `divergindo do dimensions=${res.dimensions} reportado pelo sidecar`,
    });
  }
});

/**
 * Confere `health` contra o modelo/revisão pinados (ADR-005). Explode com
 * mensagem clara em PT se divergir — vetores de builds diferentes não são
 * comparáveis por `<=>`.
 */
export function assertExpectedRevision(health: EmbedderHealth): void {
  if (health.model !== EXPECTED_MODEL_NAME || health.revision !== EXPECTED_HF_REVISION) {
    throw new Error(
      "embedQuery: build do sidecar de embedding diverge do esperado (ADR-005) — " +
        `esperado "${EXPECTED_MODEL_NAME}@${EXPECTED_HF_REVISION}", ` +
        `recebido "${health.model}@${health.revision}". Vetores de builds diferentes não são ` +
        "comparáveis; o retrieval só consulta com o mesmo build que gerou o corpus.",
    );
  }
}

// --- Cliente HTTP do sidecar (injetável) ------------------------------------

/** Porta mínima que `QueryEmbedder` precisa do sidecar — real (HTTP) ou fake (testes). */
export interface EmbedderClient {
  health(): Promise<EmbedderHealth>;
  embed(texts: readonly string[]): Promise<EmbedResponse>;
}

/** Timeout do `/health` (checagem rápida): sidecar pendurado vira erro, não hang. */
export const HEALTH_TIMEOUT_MS = 10_000;
/** Timeout de uma chamada a `/embed` — uma query é curta, mas o teto é generoso (BGE-M3 em CPU). */
export const EMBED_TIMEOUT_MS = 600_000;

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `embedQuery: falha de rede ao chamar ${url} (timeout ${timeoutMs}ms) — ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`embedQuery: ${url} respondeu HTTP ${response.status} — ${body}`);
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
        throw new Error("embedQuery: lote vazio enviado ao sidecar — bug de chamada, não deveria acontecer");
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

/**
 * Valida a dimensão do vetor de resposta contra `EXPECTED_EMBEDDING_DIMENSIONS`.
 * Roda dentro de `embedQuery` (não só na fronteira HTTP) — assim a trava vale
 * também para clients injetados em teste, cobrindo a mesma invariante que
 * protege `vector(1024)` no schema do Postgres.
 */
function assertExpectedDimensions(response: EmbedResponse): void {
  if (response.dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedQuery: sidecar reporta dimensions=${response.dimensions}, esperado ` +
        `${EXPECTED_EMBEDDING_DIMENSIONS} (BGE-M3 pinado) — build incompatível com o schema vector(1024)`,
    );
  }
  const bad = response.vectors.findIndex((v) => v.length !== response.dimensions);
  if (bad !== -1) {
    throw new Error(
      `embedQuery: vetor no índice ${bad} tem ${response.vectors[bad]?.length} dimensões, ` +
        `divergindo do dimensions=${response.dimensions} reportado pelo sidecar`,
    );
  }
}

// --- QueryEmbedder (caminho de leitura, uma query por vez) ------------------

/** Porta pública consumida por `searchByTheme` (N3) para embedar o texto da busca. */
export interface QueryEmbedder {
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Implementação padrão de `QueryEmbedder`: confere a trava de revisão
 * (ADR-005) uma única vez, cacheada por instância — a checagem acontece antes
 * do primeiro `embedQuery`, não a cada chamada. Chamadas concorrentes à
 * primeira compartilham a mesma promise de checagem (sem corrida de `/health`
 * duplicado).
 */
export class HttpQueryEmbedder implements QueryEmbedder {
  private healthCheck: Promise<void> | undefined;

  constructor(private readonly client: EmbedderClient) {}

  async embedQuery(text: string): Promise<number[]> {
    if (text.trim().length === 0) {
      throw new Error("embedQuery: texto de query vazio — nada para embedar");
    }
    await this.ensureHealthChecked();

    const response = await this.client.embed([text]);
    assertExpectedDimensions(response);
    const vector = response.vectors[0];
    if (vector === undefined) {
      throw new Error("embedQuery: sidecar não devolveu vetor para a query — resposta inconsistente");
    }
    return vector;
  }

  private ensureHealthChecked(): Promise<void> {
    if (this.healthCheck === undefined) {
      this.healthCheck = this.client.health().then((health) => {
        assertExpectedRevision(health);
      });
    }
    return this.healthCheck;
  }
}

/** Fábrica de conveniência: cliente HTTP real + `QueryEmbedder` padrão. */
export function createQueryEmbedder(embedderUrl: string): QueryEmbedder {
  return new HttpQueryEmbedder(createHttpEmbedderClient(embedderUrl));
}
