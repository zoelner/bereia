import { describe, expect, it } from "vitest";
import {
  NT_BOOKS,
  OT_BOOKS,
  USFM_BOOKS,
  canonicalIdSchema,
  makeCanonicalId,
  parseCanonicalId,
} from "../src/canon.js";

describe("cânon USFM", () => {
  it("tem 66 livros: 39 AT + 27 NT", () => {
    expect(OT_BOOKS).toHaveLength(39);
    expect(NT_BOOKS).toHaveLength(27);
    expect(USFM_BOOKS).toHaveLength(66);
  });

  it("não tem códigos duplicados", () => {
    expect(new Set(USFM_BOOKS).size).toBe(USFM_BOOKS.length);
  });
});

describe("canonical_id", () => {
  it("aceita IDs válidos", () => {
    expect(canonicalIdSchema.parse("MAT_5_39")).toBe("MAT_5_39");
    expect(canonicalIdSchema.parse("GEN_1_1")).toBe("GEN_1_1");
    expect(canonicalIdSchema.parse("3JN_1_2")).toBe("3JN_1_2");
    expect(canonicalIdSchema.parse("PSA_119_176")).toBe("PSA_119_176");
  });

  it("rejeita formato e livros inválidos", () => {
    expect(() => canonicalIdSchema.parse("MAT-5-39")).toThrow();
    expect(() => canonicalIdSchema.parse("mat_5_39")).toThrow();
    expect(() => canonicalIdSchema.parse("XYZ_1_1")).toThrow(); // livro fora do cânon
    expect(() => canonicalIdSchema.parse("MAT_5")).toThrow();
    expect(() => canonicalIdSchema.parse("TOB_1_1")).toThrow(); // deuterocanônico fora do MVP
  });

  it("faz roundtrip make/parse sem perda", () => {
    const ref = { book: "JHN", chapter: 3, verse: 16 } as const;
    expect(parseCanonicalId(makeCanonicalId(ref))).toEqual(ref);
  });
});
