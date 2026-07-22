import { describe, expect, it } from "vitest";
import { classifyStrong, normalizeStrong } from "./strongs.js";

/**
 * Ancorado em requisito (ADR-008): o formato dStrong do STEPBible (TAHOT/
 * TAGNT) é contrato externo (docs/plano-stepbible.md §2, §3.2). Exemplos
 * reais citados no plano — são códigos de referência lexical, não conteúdo
 * teológico.
 */
describe("normalizeStrong", () => {
  it("TAHOT: prefixo gramatical + radical entre chaves com letra de desambiguação", () => {
    // Gen.1.1#01 "בְּ/רֵאשִׁית" — prefixo H9003 (preposição) + radical {H7225G}
    expect(normalizeStrong("H9003/{H7225G}", "hebrew")).toBe("H7225");
  });

  it("TAHOT: radical solto com letra de desambiguação (sem prefixo/sufixo)", () => {
    expect(normalizeStrong("H0430G", "hebrew")).toBe("H0430");
  });

  it("TAHOT: radical entre chaves sem letra de desambiguação", () => {
    expect(normalizeStrong("{H0853}", "hebrew")).toBe("H0853");
  });

  it("TAHOT: tag só-gramatical (H9xxx) sem radical vira null", () => {
    expect(normalizeStrong("H9002", "hebrew")).toBeNull();
  });

  it("TAHOT: sufixo gramatical após o radical entre chaves", () => {
    expect(normalizeStrong("{H7225}/H9033", "hebrew")).toBe("H7225");
  });

  it("TAGNT: dStrong já limpo passa direto", () => {
    expect(normalizeStrong("G0976", "greek")).toBe("G0976");
  });

  it("TAGNT: remove letra de desambiguação", () => {
    expect(normalizeStrong("G0430G", "greek")).toBe("G0430");
  });

  it("TAGNT: tag só-gramatical (G9xxx) sem radical vira null (simetria de vocabulário)", () => {
    expect(normalizeStrong("G9002", "greek")).toBeNull();
  });

  it("toda saída não-nula casa com /^[HG]\\d{1,4}$/ (contrato strongsEntrySchema)", () => {
    const cases: [string, "hebrew" | "greek"][] = [
      ["H9003/{H7225G}", "hebrew"],
      ["H0430G", "hebrew"],
      ["{H0853}", "hebrew"],
      ["G0976", "greek"],
    ];
    for (const [dStrong, lang] of cases) {
      const result = normalizeStrong(dStrong, lang);
      expect(result).toMatch(/^[HG]\d{1,4}$/);
    }
  });

  it("idioma incompatível com o prefixo explode", () => {
    expect(() => normalizeStrong("G0976", "hebrew")).toThrow(/idioma "hebrew"/);
    expect(() => normalizeStrong("H0430G", "greek")).toThrow(/idioma "greek"/);
  });

  it("segmento fora do padrão explode com mensagem clara", () => {
    expect(() => normalizeStrong("H123", "hebrew")).toThrow(/fora do vocabulário fechado/);
    expect(() => normalizeStrong("HABC", "hebrew")).toThrow(/fora do vocabulário fechado/);
    expect(() => normalizeStrong("", "hebrew")).toThrow(/fora do vocabulário fechado/);
  });

  it("chaves malformadas explodem", () => {
    expect(() => normalizeStrong("{H0853", "hebrew")).toThrow(/fora do vocabulário fechado/);
    expect(() => normalizeStrong("H0853}", "hebrew")).toThrow(/fora do vocabulário fechado/);
  });

  it("múltiplos segmentos lexicais (palavra multi-radical não prevista) explode", () => {
    expect(() => normalizeStrong("H0001/H0002", "hebrew")).toThrow(/múltiplos segmentos lexicais/);
  });

  it("letra de desambiguação de mais de um caractere explode", () => {
    expect(() => normalizeStrong("H0430GG", "hebrew")).toThrow(/fora do vocabulário fechado/);
  });
});

describe("classifyStrong", () => {
  it("expõe a classificação tipada em vez de colapsar em null", () => {
    expect(classifyStrong("H9003/{H7225G}", "hebrew")).toEqual({
      kind: "lexical",
      strongId: "H7225",
    });
    expect(classifyStrong("H9002", "hebrew")).toEqual({ kind: "grammar", strongId: null });
  });
});
