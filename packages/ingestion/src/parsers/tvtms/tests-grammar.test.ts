import { describe, expect, it } from "vitest";
import { evaluateTests, parseTests } from "./tests-grammar.js";
import { fakeInventory } from "./testing.js";

describe("parseTests", () => {
  it("conjunção de predicados Exist/Last", () => {
    const preds = parseTests("Gen.3:1=Exist & Gen.2:24=Last", "Gen");
    expect(preds).toHaveLength(2);
    expect(preds[0]).toMatchObject({ kind: "exist", expected: true });
    expect(preds[1]).toMatchObject({ kind: "last" });
  });

  it("NotExist com subverso (Gen.3:1.2=NotExist)", () => {
    expect(parseTests("Gen.3:1.2=NotExist", "Gen")[0]).toMatchObject({
      kind: "exist",
      expected: false,
      ref: { verse: 1, subverse: "2" },
    });
  });

  it("TextBeforeV1 (título de Salmo)", () => {
    expect(parseTests("Psa.3:TextBeforeV1=NotExist", "Psa")[0]).toEqual({
      kind: "textBeforeV1", book: "Psa", chapter: 3, expected: false,
    });
  });

  it("comparação de contagem de palavras com fator e soma", () => {
    const [pred] = parseTests("Mal.3:23*2<Mal.3:22+Mal.3:24", "Mal");
    expect(pred).toMatchObject({ kind: "compare", op: "<" });
    if (pred?.kind !== "compare") throw new Error("unreachable");
    expect(pred.left).toEqual([{ ref: expect.objectContaining({ verse: 23 }), factor: 2 }]);
    expect(pred.right).toHaveLength(2);
  });

  it("tolera '&' duplicado e string vazia", () => {
    expect(parseTests("& Psa.133:3=Last", "Psa")).toHaveLength(1);
    expect(parseTests("", "Gen")).toEqual([]);
  });

  it("referência sem livro herda o livro da linha", () => {
    expect(parseTests("33:31=Exist", "Ezk")[0]).toMatchObject({
      ref: { book: "Ezk", chapter: 33, verse: 31 },
    });
  });

  it("átomo irreconhecível explode", () => {
    expect(() => parseTests("Gen.1:1~Weird", "Gen")).toThrow(/inválido/);
  });
});

describe("evaluateTests", () => {
  const inv = fakeInventory({
    Mal: { 3: { last: 24, words: { 22: 30, 23: 10, 24: 30 } } },
    Psa: { 3: { last: 9, title: false } },
  });

  it("Exist/NotExist/Last contra o inventário", () => {
    expect(evaluateTests(parseTests("Mal.3:19=Exist & Mal.3:24=Last", "Mal"), inv)).toBe(true);
    expect(evaluateTests(parseTests("Mal.3:25=Exist", "Mal"), inv)).toBe(false);
    expect(evaluateTests(parseTests("Mal.4:1=NotExist", "Mal"), inv)).toBe(true);
    expect(evaluateTests(parseTests("Mal.3:18=Last", "Mal"), inv)).toBe(false);
  });

  it("comparação de palavras decide a tradição (caso Malaquias)", () => {
    expect(evaluateTests(parseTests("Mal.3:23*2<Mal.3:22+Mal.3:24", "Mal"), inv)).toBe(true);
    expect(evaluateTests(parseTests("Mal.3:23*2>Mal.3:22+Mal.3:24", "Mal"), inv)).toBe(false);
  });

  it("TextBeforeV1 e livro ausente", () => {
    expect(evaluateTests(parseTests("Psa.3:TextBeforeV1=NotExist", "Psa"), inv)).toBe(true);
    expect(evaluateTests(parseTests("Sir.1:1=NotExist", "Sir"), inv)).toBe(true);
  });

  it("lista vazia é sempre verdadeira (AllBibles)", () => {
    expect(evaluateTests([], inv)).toBe(true);
  });
});
