import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { USFM_BOOKS, edgeSchema } from "@bereia/core";
import {
  OPENBIBLE_TO_USFM,
  isCanonicalOpenbibleBook,
  openbibleBookToUsfm,
} from "./books.js";
import { parseXrefs, type XrefParseResult } from "./parser.js";

/**
 * Ancorado em requisito (ADR-008): o formato TSV do OpenBible.info é contrato
 * externo (docs/plano-fechamento-fase1.md §2.2). Os fixtures sintéticos usam
 * referências reais e verificáveis (não conteúdo teológico inventado — são
 * apenas coordenadas de versos). A integração roda contra a fonte pinada em
 * `data/sources/`, com sha256 conferido antes de qualquer contagem.
 */

// ---------------------------------------------------------------------------
// Unit — fixtures sintéticos (sem dado real)
// ---------------------------------------------------------------------------

const HEADER = "From Verse\tTo Verse\tVotes\t#www.openbible.info CC-BY 2026-07-20";
const tsv = (...rows: string[]): string => [HEADER, ...rows].join("\n") + "\n";

describe("books.ts — mapa OpenBible → USFM", () => {
  it("cobre exatamente os 66 livros do cânon, bijetivo", () => {
    expect(Object.keys(OPENBIBLE_TO_USFM)).toHaveLength(66);
    const targets = Object.values(OPENBIBLE_TO_USFM);
    expect(new Set(targets).size).toBe(66);
    expect(new Set(targets)).toEqual(new Set(USFM_BOOKS));
  });

  it("mapeia tokens de notação SBL/OSIS específicos", () => {
    expect(openbibleBookToUsfm("Gen")).toBe("GEN");
    expect(openbibleBookToUsfm("Ps")).toBe("PSA");
    expect(openbibleBookToUsfm("John")).toBe("JHN"); // ≠ Jonah
    expect(openbibleBookToUsfm("Judg")).toBe("JDG");
    expect(openbibleBookToUsfm("Song")).toBe("SNG");
    expect(openbibleBookToUsfm("Phlm")).toBe("PHM");
    expect(openbibleBookToUsfm("3John")).toBe("3JN");
  });

  it("token deuterocanônico conhecido → null (descarte OQ-4)", () => {
    expect(openbibleBookToUsfm("Tob")).toBeNull();
    expect(openbibleBookToUsfm("Sir")).toBeNull();
    expect(isCanonicalOpenbibleBook("Tob")).toBe(false);
    expect(isCanonicalOpenbibleBook("Gen")).toBe(true);
  });

  it("token desconhecido EXPLODE (vocabulário fechado)", () => {
    expect(() => openbibleBookToUsfm("Foo")).toThrow(/desconhecido/);
    expect(() => openbibleBookToUsfm("Gn")).toThrow(/desconhecido/);
  });
});

describe("parseXrefs — expansão e determinismo", () => {
  it("verso único → uma edge kind:'tsk'", () => {
    const { edges } = parseXrefs(tsv("Gen.1.1\tExod.31.18\t-38"));
    expect(edges).toEqual([{ sourceId: "GEN_1_1", targetId: "EXO_31_18", kind: "tsk" }]);
  });

  it("range intra-capítulo → uma edge por verso (Ps.148.4-Ps.148.5 → 2)", () => {
    const { edges, stats } = parseXrefs(tsv("Gen.1.1\tPs.148.4-Ps.148.5\t59"));
    expect(edges).toEqual([
      { sourceId: "GEN_1_1", targetId: "PSA_148_4", kind: "tsk" },
      { sourceId: "GEN_1_1", targetId: "PSA_148_5", kind: "tsk" },
    ]);
    expect(stats.edges).toBe(2);
    expect(stats.deferredRanges).toBe(0);
  });

  it("range inter-capítulo → deferredRange (delegado a N7), zero edges diretas", () => {
    const { edges, deferredRanges } = parseXrefs(tsv("Matt.1.1\tGen.11.32-Gen.12.1\t3"));
    expect(edges).toHaveLength(0);
    expect(deferredRanges).toEqual([
      { sourceId: "MAT_1_1", targetStartId: "GEN_11_32", targetEndId: "GEN_12_1" },
    ]);
  });

  it("range inter-livro → deferredRange", () => {
    const { deferredRanges } = parseXrefs(tsv("Num.3.1\tLev.27.34-Num.1.1\t2"));
    expect(deferredRanges).toEqual([
      { sourceId: "NUM_3_1", targetStartId: "LEV_27_34", targetEndId: "NUM_1_1" },
    ]);
  });

  it("self-loop de expansão intra-capítulo é MANTIDO e contado (N7 remove)", () => {
    const { edges, stats } = parseXrefs(tsv("Gen.1.2\tGen.1.1-Gen.1.3\t4"));
    expect(edges.map((e) => e.targetId)).toEqual(["GEN_1_1", "GEN_1_2", "GEN_1_3"]);
    expect(stats.selfLoops).toBe(1); // GEN_1_2 → GEN_1_2
  });

  it("dedupe determinístico: expansões repetidas colapsam", () => {
    const { edges, stats } = parseXrefs(
      tsv("Gen.1.1\tPs.148.4-Ps.148.5\t59", "Gen.1.1\tPs.148.4\t10"),
    );
    expect(stats.edges).toBe(2); // PSA_148_4 aparece uma só vez
    expect(edges.filter((e) => e.targetId === "PSA_148_4")).toHaveLength(1);
  });

  it("ordem canônica total e estável (livro → capítulo → verso)", () => {
    const { edges } = parseXrefs(
      tsv(
        "Gen.1.1\tPs.148.4-Ps.148.5\t1",
        "Gen.1.1\tJohn.1.1-John.1.3\t1",
        "Gen.1.1\tExod.31.18\t1",
        "Gen.1.2\tGen.1.1-Gen.1.3\t1",
      ),
    );
    expect(edges.map((e) => `${e.sourceId}>${e.targetId}`)).toEqual([
      "GEN_1_1>EXO_31_18",
      "GEN_1_1>PSA_148_4",
      "GEN_1_1>PSA_148_5",
      "GEN_1_1>JHN_1_1",
      "GEN_1_1>JHN_1_2",
      "GEN_1_1>JHN_1_3",
      "GEN_1_2>GEN_1_1",
      "GEN_1_2>GEN_1_2",
      "GEN_1_2>GEN_1_3",
    ]);
  });

  it("toda edge produzida casa com edgeSchema do core", () => {
    const { edges } = parseXrefs(
      tsv("Gen.1.1\tJohn.1.1-John.1.3\t370", "Gen.1.1\tExod.31.18\t-38"),
    );
    for (const edge of edges) edgeSchema.parse(edge);
  });

  it("voto negativo é CARREGADO como edge (OQ-3) e contado", () => {
    const { edges, stats } = parseXrefs(tsv("Gen.1.1\tExod.31.18\t-38"));
    expect(edges).toHaveLength(1);
    expect(stats.negativeVoteLines).toBe(1);
  });
});

describe("parseXrefs — vocabulário fechado e descarte OQ-4", () => {
  it("cabeçalho inesperado EXPLODE", () => {
    expect(() => parseXrefs("qualquer\tcoisa\naaa\tbbb\t1\n")).toThrow(/cabeçalho/);
  });

  it("voto não-inteiro EXPLODE", () => {
    expect(() => parseXrefs(tsv("Gen.1.1\tGen.1.2\tabc"))).toThrow(/voto não-inteiro/);
  });

  it("número de colunas ≠ 3 EXPLODE", () => {
    expect(() => parseXrefs(tsv("Gen.1.1\tGen.1.2"))).toThrow(/3 colunas/);
  });

  it("token de livro desconhecido EXPLODE", () => {
    expect(() => parseXrefs(tsv("Foo.1.1\tGen.1.1\t1"))).toThrow(/desconhecido/);
  });

  it("referência malformada EXPLODE", () => {
    expect(() => parseXrefs(tsv("Gen.1\tGen.1.2\t1"))).toThrow(/malformada/);
  });

  it("endpoint deuterocanônico é DESCARTADO com estatística (não explode)", () => {
    const { stats } = parseXrefs(tsv("Tob.1.1\tGen.1.1\t1", "Gen.1.1\tGen.1.2\t1"), {
      discardCeiling: 1,
    });
    expect(stats.discardedOutOfCanon).toBe(1);
    expect(stats.discardRate).toBeCloseTo(0.5, 10);
    expect(stats.edges).toBe(1); // só a linha canônica
  });

  it("taxa de descarte acima do teto FAZ O PARSE FALHAR (OQ-4)", () => {
    expect(() => parseXrefs(tsv("Tob.1.1\tGen.1.1\t1", "Gen.1.1\tGen.1.2\t1"))).toThrow(
      /taxa de descarte/,
    );
  });
});

// ---------------------------------------------------------------------------
// Integração — fonte real pinada (data/sources/, fora do Git; pula se ausente)
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const XREFS_FILE = path.join(dataDir, "sources", "openbible-xrefs", "cross_references.txt");
const hasFile = existsSync(XREFS_FILE);

/** sha256 do membro `cross_references.txt` do zip pinado `openbible-xrefs` (9beb9c…). */
const XREFS_SHA256 = "50b59ef73efcd73da53d6140ca7fc0eb515e9fa3148211b2d723d687a2f36e01";
/** Contagens atreladas ao sha256 acima (âncoras ADR-008). */
const EXPECTED = {
  dataLines: 344799,
  edges: 605485,
  selfLoops: 64,
  deferredRanges: 655,
  negativeVoteLines: 1248,
  discardedOutOfCanon: 0,
} as const;
/** sha256 da saída ordenada (`${sourceId}\t${targetId}\n`) — pino de determinismo. */
const EDGES_SORTED_SHA256 =
  "46f4aea8a111347aabdf444e502daad80550bb15c1644e5e3a6d8e2e27d8c7c1";
/** sha256 dos deferredRanges ordenados (`${sourceId}\t${startId}\t${endId}\n`). */
const DEFERRED_SORTED_SHA256 =
  "edf708d16914decc8c043494179fd574888b4a2810f17603bda100be626d4dbd";

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

describe.skipIf(!hasFile)("integração — cross_references.txt real", () => {
  let result: XrefParseResult;

  beforeAll(() => {
    const raw = readFileSync(XREFS_FILE);
    // sha256 ANTES de qualquer asserção de contagem — pin da fonte (ADR-006/008).
    expect(sha256(raw)).toBe(XREFS_SHA256);
    result = parseXrefs(raw.toString("utf8"));
  });

  it("contagens exatas atreladas ao sha256 do manifest", () => {
    expect(result.stats.dataLines).toBe(EXPECTED.dataLines);
    expect(result.stats.edges).toBe(EXPECTED.edges);
    expect(result.stats.selfLoops).toBe(EXPECTED.selfLoops);
    expect(result.stats.deferredRanges).toBe(EXPECTED.deferredRanges);
    expect(result.stats.negativeVoteLines).toBe(EXPECTED.negativeVoteLines);
  });

  it("taxa de descarte fora-do-cânon = 0% no corpus 66 livros (OQ-4)", () => {
    expect(result.stats.discardedOutOfCanon).toBe(EXPECTED.discardedOutOfCanon);
    expect(result.stats.discardRate).toBe(0);
  });

  it("book-map cobre TODOS os tokens de livro reais do arquivo", () => {
    const tokens = new Set<string>();
    const re = /^([0-9A-Za-z]+)\./;
    for (const line of readFileSync(XREFS_FILE, "utf8").split("\n").slice(1)) {
      if (line.length === 0) continue;
      const [from, to] = line.split("\t");
      for (const endpoint of [from, ...(to?.split("-") ?? [])]) {
        const m = re.exec(endpoint ?? "");
        if (m) tokens.add(m[1] as string);
      }
    }
    expect(tokens.size).toBe(66);
    for (const token of tokens) expect(isCanonicalOpenbibleBook(token)).toBe(true);
  });

  it("caso-ouro: Gen.1.1 → John.1.1-John.1.3 expande em 3 edges", () => {
    const targets = result.edges
      .filter((e) => e.sourceId === "GEN_1_1" && e.targetId.startsWith("JHN_1_"))
      .map((e) => e.targetId);
    expect(targets).toEqual(expect.arrayContaining(["JHN_1_1", "JHN_1_2", "JHN_1_3"]));
  });

  it("saída determinística: sha256 das edges/ranges ordenados bate o pino", () => {
    const edgesBlob = result.edges.map((e) => `${e.sourceId}\t${e.targetId}\n`).join("");
    expect(sha256(edgesBlob)).toBe(EDGES_SORTED_SHA256);
    const rangesBlob = result.deferredRanges
      .map((r) => `${r.sourceId}\t${r.targetStartId}\t${r.targetEndId}\n`)
      .join("");
    expect(sha256(rangesBlob)).toBe(DEFERRED_SORTED_SHA256);
  });

  it("amostra de edges reais casa com edgeSchema", () => {
    for (const edge of result.edges.slice(0, 200)) edgeSchema.parse(edge);
    for (const edge of result.edges.slice(-200)) edgeSchema.parse(edge);
  });

  it("re-parse é byte-idêntico (determinismo)", () => {
    const again = parseXrefs(readFileSync(XREFS_FILE, "utf8"));
    expect(again.stats).toEqual(result.stats);
    expect(again.edges[0]).toEqual(result.edges[0]);
    expect(again.edges.at(-1)).toEqual(result.edges.at(-1));
  });
});

if (!hasFile) {
  it("fonte openbible-xrefs ausente — integração PULADA (ver manifest.json)", () => {
    expect(hasFile).toBe(false);
  });
}
