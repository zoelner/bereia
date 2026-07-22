import { describe, expect, it } from "vitest";
import { originalWordSchema } from "../src/schemas.js";

// Dados sintéticos (mock), sem valor teológico — só provam o contrato do schema (N0/OQ-6).
const baseWord = {
  canonicalId: "ROM_16_24",
  position: 0,
  lexeme: "χάρις",
  strongId: "G5485",
  strongRaw: "G5485",
  morphology: "N-NSF",
};

describe("originalWordSchema — coluna edition (N0/OQ-6)", () => {
  it("aceita carimbo de edição (TR/NA/variante) como string", () => {
    const parsed = originalWordSchema.parse({ ...baseWord, edition: "K" });
    expect(parsed.edition).toBe("K");
  });

  it("aceita edition null (TAHOT/fontes sem carimbo de edição)", () => {
    const parsed = originalWordSchema.parse({ ...baseWord, edition: null });
    expect(parsed.edition).toBeNull();
  });

  it("explode se edition estiver ausente (nullable, não opcional — mesmo padrão de strongRaw)", () => {
    const { edition: _edition, ...withoutEdition } = { ...baseWord, edition: "K" };
    expect(() => originalWordSchema.parse(withoutEdition)).toThrow();
  });
});
