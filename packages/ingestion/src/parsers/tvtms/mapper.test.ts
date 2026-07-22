import { describe, expect, it } from "vitest";
import { parseTvtmsExpanded } from "./expanded.js";
import { AmbiguousMappingError, TvtmsMapper } from "./mapper.js";
import { fakeInventory, fakeStandardInventory } from "./testing.js";

/** Monta um mini-TVTMS válido a partir de linhas [SourceType, SourceRef, StandardRef, Action, Tests]. */
function miniTvtms(rows: [string, string, string, string, string][]): string {
  const header = "SourceType\tSourceRef\tStandardRef\tAction\tNoteMarker\tRN\tVN\tAV\tTests";
  const body = rows.map(
    ([type, source, standard, action, tests]) =>
      `${type}\t${source}\t${standard}\t${action}\t\t\t\t\t${tests}`,
  );
  return ["#DataStart(Expanded)", header, ...body, "#DataEnd(Expanded)"].join("\n");
}

const std = fakeStandardInventory({ GEN: { 2: 25 } });

describe("parseTvtmsExpanded (mini-TSV)", () => {
  it("parseia regras, marca starred e pula deuterocanônicos com estatística", () => {
    const { rules, skipped } = parseTvtmsExpanded(
      miniTvtms([
        ["Hebrew", "Psa.3:2", "Psa.3:1", "Renumber verse", "Psa.3:2=Exist"],
        ["Greek", "Gen.3:1", "Gen.2:25-3:1", "Concatenation*", ""],
        ["Greek", "Sir.1:1", "Sir.1:1", "Keep verse", ""],
      ]),
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ action: "Renumber verse", starred: false, sourceType: "Hebrew" });
    expect(rules[1]).toMatchObject({ action: "Concatenation", starred: true });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ sourceRef: "Sir.1:1" });
  });

  it("ação fora do vocabulário fechado explode com número de linha", () => {
    expect(() =>
      parseTvtmsExpanded(miniTvtms([["Hebrew", "Gen.1:1", "Gen.1:1", "Invented action", ""]])),
    ).toThrow(/linha 3.*Invented action/);
  });
});

describe("TvtmsMapper", () => {
  it("verso sem regra ativa mapeia para si mesmo (TVTMS só lista diferenças)", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([["Hebrew", "Psa.3:2", "Psa.3:1", "Renumber verse", "Psa.3:9=Last"]]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({ Gen: { 1: { last: 31 } } }), std);
    expect(mapper.toKjv({ book: "GEN", chapter: 1, verse: 5, tradition: "Hebrew" })).toEqual([
      { book: "GEN", chapter: 1, verse: 5, subverse: null },
    ]);
  });

  it("regra só se aplica quando os Tests passam contra a fonte", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([["Hebrew", "Psa.3:2", "Psa.3:1", "Renumber verse", "Psa.3:9=Last"]]),
    );
    const hebrewLike = new TvtmsMapper(rules, fakeInventory({ Psa: { 3: { last: 9 } } }), std);
    const englishLike = new TvtmsMapper(rules, fakeInventory({ Psa: { 3: { last: 8 } } }), std);
    const query = { book: "PSA", chapter: 3, verse: 2, tradition: "Hebrew" } as const;
    expect(hebrewLike.toKjv(query)).toEqual([{ book: "PSA", chapter: 3, verse: 1, subverse: null }]);
    expect(englishLike.toKjv(query)).toEqual([{ book: "PSA", chapter: 3, verse: 2, subverse: null }]);
  });

  it("expande range de StandardRef via inventário-mestre e une partes do mesmo sourceType", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([
        ["Greek", "Gen.3:1", "Gen.2:25-3:1", "Concatenation", ""],
        ["Greek", "Gen.3:1!a", "Gen.2:25", "MergedNext verse", ""],
        ["Greek", "Gen.3:1!b", "Gen.3:1", "Keep verse", ""],
      ]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({}), std);
    expect(mapper.toKjv({ book: "GEN", chapter: 3, verse: 1, tradition: "Greek" })).toEqual([
      { book: "GEN", chapter: 2, verse: 25, subverse: null },
      { book: "GEN", chapter: 3, verse: 1, subverse: null },
    ]);
  });

  it("tradições ativas divergentes: ref.tradition desempata", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([
        ["Hebrew", "Jol.3:1", "Jol.2:28", "Renumber verse", ""],
        ["Latin", "Jol.3:1", "Jol.3:1", "Keep verse", ""],
      ]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({}), std);
    expect(mapper.toKjv({ book: "JOL", chapter: 3, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "JOL", chapter: 2, verse: 28, subverse: null },
    ]);
  });

  it("ambiguidade sem desempate EXPLODE — mapeamento não-determinístico é bug", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([
        ["Hebrew", "Jol.3:1", "Jol.2:28", "Renumber verse", ""],
        ["Latin", "Jol.3:1", "Jol.3:1", "Keep verse", ""],
      ]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({}), std);
    expect(() =>
      mapper.toKjv({ book: "JOL", chapter: 3, verse: 1, tradition: "Greek2" }),
    ).toThrow(AmbiguousMappingError);
  });

  it("título de Salmo (Standard Title) vira verse 0", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([["Hebrew", "Psa.3:1", "Psa.3:Title", "Renumber title", ""]]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({}), std);
    expect(mapper.toKjv({ book: "PSA", chapter: 3, verse: 1, tradition: "Hebrew" })).toEqual([
      { book: "PSA", chapter: 3, verse: 0, subverse: null },
    ]);
  });

  it("range em SourceRef casa versos internos (3Jn.1:14-15)", () => {
    const { rules } = parseTvtmsExpanded(
      miniTvtms([["Greek", "3Jn.1:14-15", "3Jn.1:14", "Concatenation", ""]]),
    );
    const mapper = new TvtmsMapper(rules, fakeInventory({}), std);
    expect(mapper.toKjv({ book: "3JN", chapter: 1, verse: 15, tradition: "Greek" })).toEqual([
      { book: "3JN", chapter: 1, verse: 14, subverse: null },
    ]);
  });
});
