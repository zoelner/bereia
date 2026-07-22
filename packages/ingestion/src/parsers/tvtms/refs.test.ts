import { describe, expect, it } from "vitest";
import { parseRefList, parseSingleRef } from "./refs.js";
import { TVTMS_TO_USFM, tvtmsBookToUsfm, USFM_TO_TVTMS } from "./books.js";
import { USFM_BOOKS } from "@bereia/core";

describe("tabela de livros TVTMS → USFM", () => {
  it("cobre exatamente os 66 livros do cânon, sem duplicatas", () => {
    const values = Object.values(TVTMS_TO_USFM);
    expect(values).toHaveLength(66);
    expect(new Set(values).size).toBe(66);
    expect([...values].sort()).toEqual([...USFM_BOOKS].sort());
    expect(Object.keys(USFM_TO_TVTMS)).toHaveLength(66);
  });

  it("distingue canônico, deuterocanônico conhecido e desconhecido", () => {
    expect(tvtmsBookToUsfm("Jhn")).toBe("JHN");
    expect(tvtmsBookToUsfm("Sir")).toBeNull();
    expect(() => tvtmsBookToUsfm("Xyz")).toThrow(/desconhecido/);
  });
});

describe("parseRefList", () => {
  it("referência simples", () => {
    expect(parseRefList("Gen.2:25")).toEqual([
      { kind: "single", ref: { book: "Gen", chapter: 2, verse: 25, subverse: null } },
    ]);
  });

  it("subversos nas três notações (!a, !0, .2, letra colada)", () => {
    expect(parseSingleRef("Gen.3:1!a").subverse).toBe("a");
    expect(parseSingleRef("1Ki.10:22!0").subverse).toBe("0");
    expect(parseSingleRef("Gen.6:1.2").subverse).toBe("2");
    expect(parseSingleRef("Dan.4:37a").subverse).toBe("a");
  });

  it("título de Salmo", () => {
    expect(parseSingleRef("Psa.3:Title")).toEqual({
      book: "Psa", chapter: 3, verse: "Title", subverse: null,
    });
  });

  it("range entre capítulos (Gen.2:25-3:1)", () => {
    expect(parseRefList("Gen.2:25-3:1")).toEqual([
      {
        kind: "range",
        start: { book: "Gen", chapter: 2, verse: 25, subverse: null },
        end: { book: "Gen", chapter: 3, verse: 1, subverse: null },
      },
    ]);
  });

  it("range de fonte (3Jn.1:14-15)", () => {
    expect(parseRefList("3Jn.1:14-15")).toEqual([
      {
        kind: "range",
        start: { book: "3Jn", chapter: 1, verse: 14, subverse: null },
        end: { book: "3Jn", chapter: 1, verse: 15, subverse: null },
      },
    ]);
  });

  it("lista com herança de livro e capítulo (1Ki.12:24; 11:19, 21-22)", () => {
    const items = parseRefList("1Ki.12:24; 11:19, 21-22");
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      kind: "single", ref: { book: "1Ki", chapter: 12, verse: 24, subverse: null },
    });
    expect(items[1]).toEqual({
      kind: "single", ref: { book: "1Ki", chapter: 11, verse: 19, subverse: null },
    });
    expect(items[2]).toMatchObject({
      kind: "range",
      start: { book: "1Ki", chapter: 11, verse: 21 },
      end: { book: "1Ki", chapter: 11, verse: 22 },
    });
  });

  it("range de subverso na mesma referência (Dan.4:34; 4:37a-c)", () => {
    const items = parseRefList("Dan.4:34; 4:37a-c");
    expect(items[1]).toEqual({
      kind: "range",
      start: { book: "Dan", chapter: 4, verse: 37, subverse: "a" },
      end: { book: "Dan", chapter: 4, verse: 37, subverse: "c" },
    });
  });

  it("referência sem livro herda o contexto (Tests)", () => {
    expect(parseSingleRef("33:31", "Ezk")).toMatchObject({ book: "Ezk", chapter: 33, verse: 31 });
  });

  it("capítulo-letra deuterocanônico (Est.C:1)", () => {
    expect(parseSingleRef("Est.C:1")).toMatchObject({ book: "Est", chapter: "C", verse: 1 });
  });

  it("typo do upstream em livro deuterocanônico vira raw, não erro", () => {
    const items = parseRefList("Ade.10:4-13: 11:1");
    expect(items.some((i) => i.kind === "raw")).toBe(true);
  });

  it("gramática inválida em livro canônico EXPLODE", () => {
    expect(() => parseRefList("Gen.1:2x3!")).toThrow(/inválida/);
  });
});
