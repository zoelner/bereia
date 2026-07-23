import { describe, expect, it } from "vitest";
import {
  EXPECTED_HF_REVISION,
  EXPECTED_MODEL_NAME,
  HttpQueryEmbedder,
  assertExpectedRevision,
  type EmbedderClient,
  type EmbedResponse,
  type EmbedderHealth,
} from "./embedder.js";

/**
 * Ancorado no comando de aceite do N2 (plano §7, linha N2): unit puro, client
 * injetável, SEM rede — revisão divergente explode antes de qualquer embed,
 * dimensão ≠1024 explode, health checado exatamente 1× para N queries, texto
 * vazio → erro claro.
 */

function fakeVector(dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => i / dimensions);
}

interface FakeClientOptions {
  model?: string;
  revision?: string;
  dimensions?: number;
}

function makeFakeClient(options: FakeClientOptions = {}): {
  client: EmbedderClient;
  healthCalls: number;
  embedCalls: string[][];
} {
  const model = options.model ?? EXPECTED_MODEL_NAME;
  const revision = options.revision ?? EXPECTED_HF_REVISION;
  const dimensions = options.dimensions ?? 1024;
  let healthCalls = 0;
  const embedCalls: string[][] = [];

  const client: EmbedderClient = {
    async health(): Promise<EmbedderHealth> {
      healthCalls += 1;
      return { status: "ok", model, revision };
    },
    async embed(texts: readonly string[]): Promise<EmbedResponse> {
      embedCalls.push([...texts]);
      return {
        vectors: texts.map(() => fakeVector(dimensions)),
        model,
        revision,
        dimensions,
      };
    },
  };

  return {
    client,
    get healthCalls() {
      return healthCalls;
    },
    get embedCalls() {
      return embedCalls;
    },
  };
}

describe("trava de revisão do sidecar (ADR-005)", () => {
  it("aceita silenciosamente quando model+revision batem com o esperado", () => {
    expect(() =>
      assertExpectedRevision({ status: "ok", model: EXPECTED_MODEL_NAME, revision: EXPECTED_HF_REVISION }),
    ).not.toThrow();
  });

  it("explode quando a revisão diverge", () => {
    expect(() =>
      assertExpectedRevision({ status: "ok", model: EXPECTED_MODEL_NAME, revision: "outra-revisao" }),
    ).toThrow(/ADR-005/);
  });

  it("explode quando o nome do modelo diverge", () => {
    expect(() => assertExpectedRevision({ status: "ok", model: "outro/modelo", revision: EXPECTED_HF_REVISION })).toThrow(
      /ADR-005/,
    );
  });
});

describe("HttpQueryEmbedder.embedQuery — trava de revisão antes do embed", () => {
  it("revisão divergente explode ANTES de chamar /embed (fail fast)", async () => {
    const fake = makeFakeClient({ revision: "revisao-errada" });
    const embedder = new HttpQueryEmbedder(fake.client);

    await expect(embedder.embedQuery("graça")).rejects.toThrow(/ADR-005/);
    expect(fake.embedCalls).toHaveLength(0);
  });

  it("modelo divergente explode ANTES de chamar /embed", async () => {
    const fake = makeFakeClient({ model: "outro/modelo" });
    const embedder = new HttpQueryEmbedder(fake.client);

    await expect(embedder.embedQuery("graça")).rejects.toThrow(/ADR-005/);
    expect(fake.embedCalls).toHaveLength(0);
  });
});

describe("HttpQueryEmbedder.embedQuery — trava de dimensão", () => {
  it("dimensão ≠1024 explode", async () => {
    const fake = makeFakeClient({ dimensions: 768 });
    const embedder = new HttpQueryEmbedder(fake.client);

    await expect(embedder.embedQuery("graça")).rejects.toThrow(/1024/);
  });
});

describe("HttpQueryEmbedder.embedQuery — cache do health-check por instância", () => {
  it("health é checado exatamente 1× para N queries", async () => {
    const fake = makeFakeClient();
    const embedder = new HttpQueryEmbedder(fake.client);

    const vectors = await Promise.all([
      embedder.embedQuery("graça"),
      embedder.embedQuery("fé"),
      embedder.embedQuery("mostarda"),
    ]);

    expect(fake.healthCalls).toBe(1);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(1024);
    }
  });

  it("health é checado 1× também em chamadas sequenciais", async () => {
    const fake = makeFakeClient();
    const embedder = new HttpQueryEmbedder(fake.client);

    await embedder.embedQuery("graça");
    await embedder.embedQuery("fé");

    expect(fake.healthCalls).toBe(1);
  });
});

describe("HttpQueryEmbedder.embedQuery — texto vazio", () => {
  it("texto vazio produz erro claro", async () => {
    const fake = makeFakeClient();
    const embedder = new HttpQueryEmbedder(fake.client);

    await expect(embedder.embedQuery("")).rejects.toThrow(/vazio/);
  });

  it("texto só com espaços produz erro claro", async () => {
    const fake = makeFakeClient();
    const embedder = new HttpQueryEmbedder(fake.client);

    await expect(embedder.embedQuery("   ")).rejects.toThrow(/vazio/);
  });
});

describe("HttpQueryEmbedder.embedQuery — vetor devolvido", () => {
  it("devolve o vetor da query com a dimensão pinada", async () => {
    const fake = makeFakeClient();
    const embedder = new HttpQueryEmbedder(fake.client);

    const vector = await embedder.embedQuery("o grão de mostarda");

    expect(vector).toHaveLength(1024);
    expect(fake.embedCalls).toEqual([["o grão de mostarda"]]);
  });
});
