import { describe, expect, it } from "vitest";
import type { CanonicalId } from "./canon.js";
import { exegesisResultSchema, type ExegesisResult, type RetrievalService } from "./retrieval.js";
import type { CanonicalVerse, Edge, Interpretation, User, VerseText } from "./schemas.js";

/**
 * Teste de CONTRATO do port `RetrievalService` (ADR-008): âncora é o shape
 * público, não uma implementação. Sem banco, sem rede — fixture sintética
 * marcada como mock, zero conteúdo teológico real (CLAUDE.md §7).
 */

const MOCK_VERSE: CanonicalVerse = {
  id: "OBA_1_1" as CanonicalId,
  book: "OBA",
  chapter: 1,
  verse: 1,
  canonStatus: "protestant",
  theologicalCategory: null,
};

const MOCK_TEXTS: VerseText[] = [
  {
    canonicalId: "OBA_1_1" as CanonicalId,
    translation: "mock-translation",
    text: "texto sintético de mock, sem valor teológico",
    embeddingModel: null,
    thematicTags: [],
    culturalContext: null,
    humanReviewed: false,
    reviewedBy: null,
    authorizedLevels: ["public"],
  },
];

const MOCK_ORIGINAL_WORDS = [
  {
    canonicalId: "OBA_1_1" as CanonicalId,
    position: 0,
    lexeme: "mock-lexeme-resolvido",
    strongId: "H0001",
    strongRaw: "H0001",
    morphology: null,
    edition: null,
    strong: {
      id: "H0001",
      language: "hebrew" as const,
      lemma: "mock-lemma",
      transliteration: null,
      definition: "definição sintética de mock",
    },
  },
  {
    // Estendido (5-díg./G6xxx-G7xxx): strongId permanece null, strongRaw preserva o bruto (backlog Fase 1).
    canonicalId: "OBA_1_1" as CanonicalId,
    position: 1,
    lexeme: "mock-lexeme-estendido",
    strongId: null,
    strongRaw: "H90001",
    morphology: null,
    edition: null,
  },
];

const MOCK_INTERPRETATION_A: Interpretation = {
  id: "mock-interp-a",
  canonicalId: "OBA_1_1" as CanonicalId,
  viewLabel: "mock-view-a",
  text: "visão sintética A, sem valor teológico",
  tradition: null,
  source: null,
  humanReviewed: false,
  reviewedBy: null,
};

const MOCK_INTERPRETATION_B: Interpretation = {
  id: "mock-interp-b",
  canonicalId: "OBA_1_1" as CanonicalId,
  viewLabel: "mock-view-b",
  text: "visão sintética B, divergente de A, sem valor teológico",
  tradition: null,
  source: null,
  humanReviewed: false,
  reviewedBy: null,
};

const MOCK_EXEGESIS: ExegesisResult = {
  verse: MOCK_VERSE,
  texts: MOCK_TEXTS,
  originalWords: MOCK_ORIGINAL_WORDS,
  interpretations: [MOCK_INTERPRETATION_A, MOCK_INTERPRETATION_B],
};

const MOCK_USER: User = { id: "mock-user", accessLevels: ["public"] };

describe("exegesisResultSchema — shape de getExegesis (N1, ADR-010)", () => {
  it("aceita o shape completo: verse + texts + originalWords (com strong resolvido) + interpretations", () => {
    const parsed = exegesisResultSchema.parse(MOCK_EXEGESIS);
    expect(parsed.verse.id).toBe("OBA_1_1");
    expect(parsed.originalWords).toHaveLength(2);
    expect(parsed.interpretations).toHaveLength(2);
  });

  it("preserva strongId:null + strongRaw para palavras estendidas (5-díg./G6xxx-G7xxx)", () => {
    const parsed = exegesisResultSchema.parse(MOCK_EXEGESIS);
    const extended = parsed.originalWords[1];
    expect(extended?.strongId).toBeNull();
    expect(extended?.strongRaw).toBe("H90001");
    expect(extended?.strong).toBeUndefined();
  });

  it("originalWords não exige `strong` (join pode não resolver)", () => {
    const withoutStrongJoin = {
      ...MOCK_EXEGESIS,
      originalWords: [MOCK_ORIGINAL_WORDS[1]],
    };
    expect(() => exegesisResultSchema.parse(withoutStrongJoin)).not.toThrow();
  });

  it("interpretations com 2 entradas divergentes permanecem 2 entradas distintas — nunca fundidas (anti-ambiguidade)", () => {
    const parsed = exegesisResultSchema.parse(MOCK_EXEGESIS);
    expect(parsed.interpretations).toHaveLength(2);
    expect(parsed.interpretations[0]?.viewLabel).not.toBe(parsed.interpretations[1]?.viewLabel);
    expect(parsed.interpretations[0]?.text).not.toBe(parsed.interpretations[1]?.text);
    // O tipo não expõe nenhum campo de resumo/fusão — só o array cru.
    expect(parsed).not.toHaveProperty("summary");
  });

  it("rejeita shape malformado (texts como objeto solto, não array)", () => {
    const malformed = { ...MOCK_EXEGESIS, texts: MOCK_TEXTS[0] };
    expect(() => exegesisResultSchema.parse(malformed)).toThrow();
  });
});

/**
 * Retrocompat: uma implementação fake mínima do port precisa compilar sem
 * alterar `searchByTheme`/`getVerse`/`getCrossReferences` — prova de que a
 * extensão (`getExegesis`) não quebrou os métodos existentes (ADR-008).
 */
class FakeRetrievalService implements RetrievalService {
  async searchByTheme() {
    return [];
  }

  async getVerse(): Promise<{ verse: CanonicalVerse; texts: VerseText[] } | null> {
    return { verse: MOCK_VERSE, texts: MOCK_TEXTS };
  }

  async getExegesis(): Promise<ExegesisResult | null> {
    return MOCK_EXEGESIS;
  }

  async getCrossReferences(): Promise<Edge[]> {
    return [];
  }
}

describe("RetrievalService — retrocompat dos métodos existentes (N1)", () => {
  const service: RetrievalService = new FakeRetrievalService();

  it("getVerse continua devolvendo { verse, texts } (shape intocado)", async () => {
    const result = await service.getVerse("OBA_1_1" as CanonicalId, MOCK_USER);
    expect(result?.verse.id).toBe("OBA_1_1");
    expect(result?.texts).toEqual(MOCK_TEXTS);
  });

  it("searchByTheme e getCrossReferences continuam presentes no port com as assinaturas atuais", async () => {
    await expect(service.searchByTheme("mock-query", MOCK_USER)).resolves.toEqual([]);
    await expect(service.getCrossReferences("OBA_1_1" as CanonicalId, MOCK_USER)).resolves.toEqual([]);
  });

  it("getExegesis devolve o shape novo validável por exegesisResultSchema", async () => {
    const result = await service.getExegesis("OBA_1_1" as CanonicalId, MOCK_USER);
    expect(result).not.toBeNull();
    expect(() => exegesisResultSchema.parse(result)).not.toThrow();
  });

  it("verso inexistente → null (contrato de getExegesis)", async () => {
    class NotFoundService extends FakeRetrievalService {
      override async getExegesis(): Promise<ExegesisResult | null> {
        return null;
      }
    }
    const notFound: RetrievalService = new NotFoundService();
    await expect(notFound.getExegesis("PHM_1_1" as CanonicalId, MOCK_USER)).resolves.toBeNull();
  });
});
