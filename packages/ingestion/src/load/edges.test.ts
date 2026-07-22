import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { edgeSchema, type CanonicalId, type CanonicalVerse, type Edge, type UsfmBook } from "@bereia/core";
import type { XrefDeferredRange } from "../parsers/xrefs/parser.js";
import { parseXrefs } from "../parsers/xrefs/parser.js";
import { parseUsfx } from "../parsers/usfx/parser.js";
import { buildCanonicalVerses } from "./verses.js";
import { buildEdges } from "./edges.js";
import { readEdges, writeEdges } from "./jsonl.js";
import { compareEdge } from "./order.js";

/**
 * Testes ancorados em requisito (ADR-008). Unit: inventário-mestre e edges
 * SINTÉTICOS (coordenadas de verso reais/estruturais, NUNCA conteúdo teológico
 * inventado) exercitando cada política fixada — expansão de range com e sem
 * verso 0 no miolo (OQ-2), self-loop (direto e criado por expansão), endpoint
 * fora do mestre (OQ-4), teto de descarte, range decrescente, determinismo/FK.
 * Integração: números EXATOS atrelados ao sha256 das fontes pinadas (xrefs +
 * manifest da KJV), com pelo menos um `deferredRange` real conferido à mão
 * contra o dado bruto. Pula quando as fontes faltam (nunca verde falso).
 */

// --- helpers de estrutura sintética (mock) --------------------------------

const cid = (s: string): CanonicalId => s as CanonicalId;

/** Uma linha de `canonical_verses` mock (metadados fixos do plano §3.3). */
function mv(book: UsfmBook, chapter: number, verse: number): CanonicalVerse {
  return {
    id: cid(`${book}_${chapter}_${verse}`),
    book,
    chapter,
    verse,
    canonStatus: "protestant",
    theologicalCategory: null,
  };
}

function edge(source: string, target: string): Edge {
  return { sourceId: cid(source), targetId: cid(target), kind: "tsk" };
}

function deferred(source: string, start: string, end: string): XrefDeferredRange {
  return { sourceId: cid(source), targetStartId: cid(start), targetEndId: cid(end) };
}

/**
 * Inventário-mestre mock: GEN 1 (v.1-3), PSA 3 e PSA 4 (cada um com título
 * verso 0 + v.1-2). Embaralhado de propósito para provar que `buildEdges`
 * ordena internamente (não confia na ordem de entrada).
 */
const MOCK_MASTER: CanonicalVerse[] = [
  mv("PSA", 4, 2),
  mv("GEN", 1, 3),
  mv("PSA", 3, 0),
  mv("PSA", 4, 0),
  mv("GEN", 1, 1),
  mv("PSA", 3, 2),
  mv("PSA", 4, 1),
  mv("GEN", 1, 2),
  mv("PSA", 3, 1),
];

describe("buildEdges — expansão de deferredRanges contra o mestre", () => {
  it("range sem verso 0 no miolo → uma edge por verso do intervalo (na ordem canônica)", () => {
    const { edges, stats } = buildEdges({
      edges: [],
      deferredRanges: [deferred("PSA_3_1", "GEN_1_1", "GEN_1_3")],
      inventory: MOCK_MASTER,
    });
    expect(edges).toEqual([
      edge("PSA_3_1", "GEN_1_1"),
      edge("PSA_3_1", "GEN_1_2"),
      edge("PSA_3_1", "GEN_1_3"),
    ]);
    expect(stats.expandedFromDeferred).toBe(3);
    expect(stats.skippedTitlesInRanges).toBe(0);
    expect(stats.finalEdges).toBe(3);
  });

  it("range COM verso 0 (título) no miolo → título PULADO com contagem (OQ-2)", () => {
    const { edges, stats } = buildEdges({
      edges: [],
      // Janela PSA_3_1..PSA_4_1: PSA_3_1, PSA_3_2, PSA_4_0 (título → pula), PSA_4_1.
      deferredRanges: [deferred("GEN_1_1", "PSA_3_1", "PSA_4_1")],
      inventory: MOCK_MASTER,
    });
    expect(edges.map((e) => e.targetId)).toEqual(["PSA_3_1", "PSA_3_2", "PSA_4_1"]);
    expect(edges.some((e) => e.targetId === "PSA_4_0")).toBe(false);
    expect(stats.skippedTitlesInRanges).toBe(1);
    expect(stats.expandedFromDeferred).toBe(3);
  });

  it("endpoints start/end podem não existir no mestre — o intervalo sai do mestre", () => {
    // start GEN_1_0 e end PSA_3_9 não existem no mestre; a janela seleciona os
    // versos-mestre entre eles (verso 0 de título pulado).
    const { edges, stats } = buildEdges({
      edges: [],
      deferredRanges: [deferred("GEN_1_2", "GEN_1_0", "GEN_1_9")],
      inventory: MOCK_MASTER,
    });
    // source GEN_1_2 cai no intervalo GEN_1_1..GEN_1_3 → self-loop removido.
    expect(edges.map((e) => e.targetId)).toEqual(["GEN_1_1", "GEN_1_3"]);
    expect(stats.selfLoopsRemoved).toBe(1);
    expect(stats.discardedOutOfMaster).toBe(0);
  });

  it("range decrescente EXPLODE (ordem canônica invertida)", () => {
    expect(() =>
      buildEdges({
        edges: [],
        deferredRanges: [deferred("GEN_1_1", "GEN_1_3", "GEN_1_1")],
        inventory: MOCK_MASTER,
      }),
    ).toThrow(/decrescente/);
  });
});

describe("buildEdges — self-loops e descarte OQ-4", () => {
  it("remove self-loops diretos (de N2) E os criados pela expansão de range, com estatística", () => {
    const { edges, stats } = buildEdges({
      edges: [edge("GEN_1_1", "GEN_1_1"), edge("GEN_1_1", "GEN_1_2")],
      // PSA_3_1 cai no próprio intervalo PSA_3_1..PSA_3_2 → self-loop de expansão.
      deferredRanges: [deferred("PSA_3_1", "PSA_3_1", "PSA_3_2")],
      inventory: MOCK_MASTER,
    });
    expect(stats.selfLoopsRemoved).toBe(2); // GEN_1_1→GEN_1_1 (direto) + PSA_3_1→PSA_3_1 (expansão)
    expect(edges).toEqual([edge("GEN_1_1", "GEN_1_2"), edge("PSA_3_1", "PSA_3_2")]);
    expect(edges.some((e) => e.sourceId === e.targetId)).toBe(false);
  });

  it("endpoint fora do mestre é DESCARTADO com estatística (source OU target)", () => {
    const { edges, stats } = buildEdges({
      edges: [
        edge("GEN_1_1", "GEN_1_9"), // target inexistente
        edge("MAT_1_1", "GEN_1_1"), // source inexistente
        edge("GEN_1_1", "GEN_1_2"), // válida
      ],
      deferredRanges: [],
      inventory: MOCK_MASTER,
      maxDiscardRate: 1,
    });
    expect(stats.discardedOutOfMaster).toBe(2);
    expect(edges).toEqual([edge("GEN_1_1", "GEN_1_2")]);
    // Invariante: toda edge final tem endpoints no mestre.
    const inv = new Set(MOCK_MASTER.map((v) => v.id));
    for (const e of edges) {
      expect(inv.has(e.sourceId)).toBe(true);
      expect(inv.has(e.targetId)).toBe(true);
    }
  });

  it("precedência FK antes de self-loop: self-loop fora do mestre conta como DESCARTE", () => {
    const { stats } = buildEdges({
      edges: [edge("MAT_1_1", "MAT_1_1")], // self-loop, mas MAT_1_1 ∉ mestre
      deferredRanges: [],
      inventory: MOCK_MASTER,
      maxDiscardRate: 1,
    });
    expect(stats.discardedOutOfMaster).toBe(1);
    expect(stats.selfLoopsRemoved).toBe(0);
  });

  it("taxa de descarte acima do teto FAZ O BUILD FALHAR ruidosamente (OQ-4)", () => {
    expect(() =>
      buildEdges({
        edges: [edge("GEN_1_1", "GEN_1_9"), edge("GEN_1_1", "GEN_1_2")], // 1 de 2 descartada = 50%
        deferredRanges: [],
        inventory: MOCK_MASTER,
        maxDiscardRate: 0.005,
      }),
    ).toThrow(/taxa de descarte/);
  });
});

describe("buildEdges — dedupe, determinismo e FK", () => {
  it("dedupe determinístico: direto e expandido que colidem colapsam num par", () => {
    const { edges, stats } = buildEdges({
      edges: [edge("GEN_1_1", "PSA_3_1")],
      deferredRanges: [deferred("GEN_1_1", "PSA_3_1", "PSA_3_2")], // reintroduz GEN_1_1→PSA_3_1
      inventory: MOCK_MASTER,
    });
    expect(edges.filter((e) => e.sourceId === "GEN_1_1" && e.targetId === "PSA_3_1")).toHaveLength(1);
    expect(edges).toEqual([edge("GEN_1_1", "PSA_3_1"), edge("GEN_1_1", "PSA_3_2")]);
    // candidateEdges únicos < directEdges + expandedFromDeferred (houve colisão).
    expect(stats.candidateEdges).toBeLessThan(stats.directEdges + stats.expandedFromDeferred);
  });

  it("ordena via comparador do N4, independente da ordem de entrada; casa edgeSchema", () => {
    const scrambled: Edge[] = [
      edge("PSA_4_1", "GEN_1_1"),
      edge("GEN_1_1", "PSA_3_2"),
      edge("GEN_1_1", "GEN_1_2"),
    ];
    const { edges } = buildEdges({ edges: scrambled, deferredRanges: [], inventory: MOCK_MASTER });
    expect(edges).toEqual([...edges].sort(compareEdge));
    expect(edges.map((e) => `${e.sourceId}>${e.targetId}`)).toEqual([
      "GEN_1_1>GEN_1_2",
      "GEN_1_1>PSA_3_2",
      "PSA_4_1>GEN_1_1",
    ]);
    for (const e of edges) edgeSchema.parse(e);
  });

  it("re-run byte-idêntico e round-trip JSONL (determinismo)", () => {
    const input = {
      edges: [edge("GEN_1_1", "GEN_1_2")],
      deferredRanges: [deferred("GEN_1_1", "PSA_3_1", "PSA_4_1")],
      inventory: MOCK_MASTER,
    };
    const a = writeEdges(buildEdges(input).edges);
    const b = writeEdges(buildEdges(input).edges);
    expect(a).toBe(b);
    expect(readEdges(a)).toEqual(buildEdges(input).edges);
  });
});

// --- integração: fontes REAIS, números atrelados ao sha256 -----------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", rel);

const FILES = {
  manifest: src("manifest.json"),
  xrefs: src("openbible-xrefs/cross_references.txt"),
  kjv: src("eng-kjv/eng-kjv_usfx.xml"),
};
const hasAll = Object.values(FILES).every((f) => existsSync(f));

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

/** sha256 do `cross_references.txt` pinado (membro do zip `openbible-xrefs`, 9beb9c…). */
const XREFS_SHA256 = "50b59ef73efcd73da53d6140ca7fc0eb515e9fa3148211b2d723d687a2f36e01";
/** sha256 do `manifest.json` — pina a KJV (inventário-mestre) e as demais fontes (âncora ADR-008). */
const MANIFEST_SHA256 = "ccc319094d9c7503609ae9de849f9991a8d5ce97c5c8cefbbc1b362c256c83a6";

/**
 * Números EXATOS atrelados aos dois sha256 acima (levantados do dado real).
 * `selfLoopsRemoved` = 64 (de N2) + 3 criados pela expansão de range cujo
 * `source` cai no próprio intervalo de destino (ISA_37_1 em ISA_36_22..37_38;
 * EPH_5_22 em EPH_5_22..6_9; REV_1_19 em REV_1_11..2_3).
 * `discardedOutOfMaster` = 1: a única cross-ref cujo endpoint não resolve na
 * KJV-mestre é `3JN_1_15 → JHN_10_3` (3Jo tem 14 versos na KJV; a numeração
 * NRSV/OpenBible parte o v.14 em 14/15) — residual NRSV↔KJV, OQ-4.
 */
const EXPECTED = {
  directEdges: 605_485,
  deferredRanges: 655,
  expandedFromDeferred: 8_791,
  skippedTitlesInRanges: 14,
  candidateEdges: 614_276,
  discardedOutOfMaster: 1,
  selfLoopsRemoved: 67,
  finalEdges: 614_208,
} as const;

/** sha256 da saída final ordenada (`${sourceId}\t${targetId}\n`) — pino de determinismo. */
const FINAL_EDGES_SHA256 = "566f1935f23a8497bcb33c17b30c75c6f516054fe28a542b96e0217ed671b19e";

describe.skipIf(!hasAll)("integração real — build de edges (fontes pinadas)", { timeout: 60_000 }, () => {
  let inventory: CanonicalVerse[];
  let result: ReturnType<typeof buildEdges>;

  beforeAll(() => {
    // sha256 ANTES de qualquer asserção de contagem — pin das fontes (ADR-006/008).
    expect(sha256(readFileSync(FILES.xrefs))).toBe(XREFS_SHA256);
    expect(sha256(readFileSync(FILES.manifest))).toBe(MANIFEST_SHA256);
    const parsed = parseXrefs(readFileSync(FILES.xrefs, "utf8"));
    inventory = buildCanonicalVerses(parseUsfx(readFileSync(FILES.kjv, "utf8")));
    result = buildEdges({ edges: parsed.edges, deferredRanges: parsed.deferredRanges, inventory });
  }, 120_000);

  it("contagens exatas atreladas ao sha256 (edges finais, expandidas, self-loops, descartes, taxa)", () => {
    expect(result.stats.directEdges).toBe(EXPECTED.directEdges);
    expect(result.stats.deferredRanges).toBe(EXPECTED.deferredRanges);
    expect(result.stats.expandedFromDeferred).toBe(EXPECTED.expandedFromDeferred);
    expect(result.stats.skippedTitlesInRanges).toBe(EXPECTED.skippedTitlesInRanges);
    expect(result.stats.candidateEdges).toBe(EXPECTED.candidateEdges);
    expect(result.stats.discardedOutOfMaster).toBe(EXPECTED.discardedOutOfMaster);
    expect(result.stats.selfLoopsRemoved).toBe(EXPECTED.selfLoopsRemoved);
    expect(result.stats.finalEdges).toBe(EXPECTED.finalEdges);
    expect(result.edges.length).toBe(EXPECTED.finalEdges);
    // taxa de descarte muito abaixo do teto de 0,5% (OQ-4).
    expect(result.stats.discardRate).toBeLessThan(0.005);
    expect(result.stats.discardRate).toBeCloseTo(1 / EXPECTED.candidateEdges, 12);
  });

  it("invariante de FK: todo endpoint ∈ inventário-mestre; nenhum self-loop", () => {
    // Varredura em loop puro (614k edges) com asserção única — um `expect` por
    // aresta estouraria o testTimeout sob carga (flakiness), não é o requisito.
    const master = new Set(inventory.map((v) => v.id));
    const keys = new Set<string>();
    let fkViolations = 0;
    let selfLoops = 0;
    for (const e of result.edges) {
      if (!master.has(e.sourceId) || !master.has(e.targetId)) fkViolations++;
      if (e.sourceId === e.targetId) selfLoops++;
      keys.add(`${e.sourceId}\t${e.targetId}`);
    }
    expect(fkViolations).toBe(0);
    expect(selfLoops).toBe(0);
    // par (source,target) único no conjunto final.
    expect(keys.size).toBe(result.edges.length);
  });

  it("descarte OQ-4: a única cross-ref fora do mestre é 3JN_1_15 → JHN_10_3", () => {
    // A edge descartada NÃO aparece no conjunto final (endpoint 3JN_1_15 ∉ KJV).
    expect(result.edges.some((e) => e.sourceId === "3JN_1_15")).toBe(false);
    expect(inventory.some((v) => v.id === "3JN_1_15")).toBe(false);
    expect(inventory.some((v) => v.id === "3JN_1_14")).toBe(true); // KJV: 3Jo termina em v.14
  });

  it("âncora manual: 1Sam.17.45 → Ps.124.8-Ps.125.1 (linha bruta) expande em 2 edges, pula o título PSA_125_0", () => {
    // Dado bruto (cross_references.txt, linha 59754): `1Sam.17.45<TAB>Ps.124.8-Ps.125.1<TAB>17`.
    // Range inter-capítulo → deferredRange {PSA_124_8, PSA_125_1}. A KJV-mestre
    // tem PSA_124_8 (último verso do Sl 124) e PSA_125_0 (título "A Song of
    // degrees" do Sl 125) e PSA_125_1. O título verso 0 é PULADO (OQ-2), logo
    // os alvos são exatamente PSA_124_8 e PSA_125_1.
    expect(inventory.some((v) => v.id === "PSA_125_0")).toBe(true); // título existe no mestre
    const fromSource = result.edges
      .filter((e) => e.sourceId === "1SA_17_45" && e.targetId.startsWith("PSA_12"))
      .map((e) => e.targetId);
    expect(fromSource).toContain("PSA_124_8");
    expect(fromSource).toContain("PSA_125_1");
    expect(fromSource).not.toContain("PSA_125_0"); // título nunca vira alvo
  });

  it("saída determinística: sha256 das edges finais ordenadas bate o pino", () => {
    const blob = result.edges.map((e) => `${e.sourceId}\t${e.targetId}\n`).join("");
    expect(sha256(blob)).toBe(FINAL_EDGES_SHA256);
  });

  it("re-run é idêntico (determinismo de produto)", () => {
    const parsed = parseXrefs(readFileSync(FILES.xrefs, "utf8"));
    const again = buildEdges({ edges: parsed.edges, deferredRanges: parsed.deferredRanges, inventory });
    expect(again.stats).toEqual(result.stats);
    expect(again.edges[0]).toEqual(result.edges[0]);
    expect(again.edges.at(-1)).toEqual(result.edges.at(-1));
  });
});

if (!hasAll) {
  it("fontes xrefs/KJV/manifest ausentes — integração PULADA (ver data/sources/manifest.json)", () => {
    expect(hasAll).toBe(false);
  });
}
