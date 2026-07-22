import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseTvtmsExpanded, type ExpandedParseResult } from "./expanded.js";
import { TvtmsMapper } from "./mapper.js";
import { fakeInventory, fakeStandardInventory } from "./testing.js";

/**
 * SUÍTE DE CASOS-OURO — gate da Fase 1 (ADR-002).
 *
 * Roda contra o arquivo TVTMS REAL (data/sources/, fora do Git) com Bíblias
 * SIMULADAS (inventários sintéticos, estrutura mock sem conteúdo teológico):
 * cada caso declara a estrutura da fonte e o mapeamento esperado na
 * versificação-mestre. 100% verde é pré-condição do 1º data/canonical/*.jsonl.
 * Sem o arquivo (CI), a suíte é PULADA — nunca falsamente verde.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const tvtmsPath = path.join(dataDir, "sources", "stepbible-tvtms", "TVTMS.txt");

const hasFile = existsSync(tvtmsPath);
const std = fakeStandardInventory();

describe.skipIf(!hasFile)("TVTMS real — casos-ouro", () => {
  let parsed: ExpandedParseResult;

  beforeAll(() => {
    parsed = parseTvtmsExpanded(readFileSync(tvtmsPath, "utf8"));
  });

  it("smoke: arquivo inteiro parseia, com vocabulário fechado", () => {
    // Números exatos do TVTMS pinado no manifest (sha256 8851a8b5…):
    // 22.874 linhas de dado = 15.933 canônicas + 6.941 deuterocanônicas puladas.
    expect(parsed.rules.length).toBe(15933);
    expect(parsed.skipped.length).toBe(6941);
    for (const skip of parsed.skipped) {
      expect(skip.reason).toMatch(/deuterocanônico/);
    }
  });

  it("títulos de Salmos: fonte hebraica conta o título como v.1", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ Psa: { 3: { last: 9, title: false } } }),
      std,
    );
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 0, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 2, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 1, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 9, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 8, subverse: null },
    ]);
  });

  it("títulos de Salmos: fonte inglesa com título separado mapeia identidade", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ Psa: { 3: { last: 8, title: true } } }),
      std,
    );
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 1, tradition: "Eng-KJV" })).toEqual([
      { book: "PSA", chapter: 3, verse: 1, subverse: null },
    ]);
  });

  it("Malaquias: hebraico 3:19-24 → inglês 4:1-6 (contagem de palavras decide)", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ Mal: { 3: { last: 24, words: { 22: 30, 23: 10, 24: 30 } } } }),
      std,
    );
    expect(mapper.toKjv({ book: "MAL", chapter: 3, verse: 19, tradition: "Hebrew" })).toEqual([
      { book: "MAL", chapter: 4, verse: 1, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "MAL", chapter: 3, verse: 24, tradition: "Hebrew" })).toEqual([
      { book: "MAL", chapter: 4, verse: 6, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "MAL", chapter: 3, verse: 18, tradition: "Hebrew" })).toEqual([
      { book: "MAL", chapter: 3, verse: 18, subverse: null },
    ]);
  });

  it("Joel: hebraico tem 4 capítulos — 3:1-5 → 2:28-32 e 4:x → 3:x", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({
        Jol: { 1: { last: 20 }, 2: { last: 27 }, 3: { last: 5 }, 4: { last: 21 } },
      }),
      std,
    );
    expect(mapper.toKjv({ book: "JOL", chapter: 3, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 2, verse: 28, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "JOL", chapter: 3, verse: 5, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 2, verse: 32, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "JOL", chapter: 4, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 3, verse: 1, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "JOL", chapter: 4, verse: 21, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 3, verse: 21, subverse: null },
    ]);
    expect(mapper.toKjv({ book: "JOL", chapter: 1, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 1, verse: 1, subverse: null },
    ]);
  });

  it("Atos 8:37: presente na fonte tipo-KJV mapeia identidade", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ Act: { 8: { last: 40 } } }),
      std,
    );
    expect(mapper.toKjv({ book: "ACT", chapter: 8, verse: 37, tradition: "Eng-KJV" })).toEqual([
      { book: "ACT", chapter: 8, verse: 37, subverse: null },
    ]);
  });

  it("3 João: fonte moderna 14-15 converge para o v.14 da KJV", () => {
    const modern = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ "3Jn": { 1: { last: 15 } } }),
      std,
    );
    expect(
      modern.toKjv({ book: "3JN", chapter: 1, verse: 15, tradition: "Greek" }).map((r) => ({
        book: r.book, chapter: r.chapter, verse: r.verse,
      })),
    ).toEqual([{ book: "3JN", chapter: 1, verse: 14 }]);

    const kjvLike = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ "3Jn": { 1: { last: 14 } } }),
      std,
    );
    expect(kjvLike.toKjv({ book: "3JN", chapter: 1, verse: 14, tradition: "Eng-KJV" })).toEqual([
      { book: "3JN", chapter: 1, verse: 14, subverse: null },
    ]);
  });

  it("Romanos 16:25-27: fonte tipo-KJV mapeia identidade", () => {
    const mapper = new TvtmsMapper(
      parsed.rules,
      fakeInventory({ Rom: { 14: { last: 23 }, 16: { last: 27 } } }),
      std,
    );
    expect(mapper.toKjv({ book: "ROM", chapter: 16, verse: 25, tradition: "Eng-KJV" })).toEqual([
      { book: "ROM", chapter: 16, verse: 25, subverse: null },
    ]);
  });
});

if (!hasFile) {
  it("TVTMS real ausente — casos-ouro PULADOS (baixe as fontes: ver manifest.json)", () => {
    expect(hasFile).toBe(false);
  });
}
