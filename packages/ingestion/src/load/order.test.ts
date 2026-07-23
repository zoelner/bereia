import { describe, expect, it } from "vitest";
import type { CanonicalVerse, Edge, OriginalWord, StrongsEntry, UsfmBook, VerseText } from "@bereia/core";
import {
  chain,
  compareCanonicalId,
  compareCanonicalRef,
  compareCanonicalVerse,
  compareEdge,
  compareEdgeKey,
  compareOrdinal,
  compareOriginalWord,
  compareStrongsEntry,
  compareVerseText,
  edgeSortKeyOf,
  sortDeterministic,
  sortDeterministicBy,
} from "./order.js";
import {
  readCanonicalVerses,
  readEdges,
  readOriginalWords,
  readStrongsEntries,
  readVerseTexts,
  serializeJsonLine,
  writeCanonicalVerses,
  writeEdges,
  writeJsonl,
  writeOriginalWords,
  writeStrongsEntries,
  writeVerseTexts,
} from "./jsonl.js";

/**
 * Ancorado em requisito (ADR-008): as propriedades exigidas pelo nó N4 são
 * (a) ordem TOTAL (nenhum par distinto compara igual), (b) ordem ESTÁVEL/
 * determinística (mesmo conjunto, qualquer permutação de entrada → mesma
 * saída), (c) verso 0 antes do verso 1, (d) livros na ordem do cânon,
 * (e) writer com chaves fixas e round-trip, (f) byte a byte idêntico entre
 * duas escritas a partir de ordens de entrada diferentes. Dados abaixo são
 * ESTRUTURA SINTÉTICA mock — canonical_id, lexeme e texto não carregam
 * conteúdo teológico real (CLAUDE.md §7).
 */

// --- Fixtures sintéticas ----------------------------------------------------

function mockVerse(book: UsfmBook, chapter: number, verse: number): CanonicalVerse {
  return {
    id: `${book}_${chapter}_${verse}`,
    book,
    chapter,
    verse,
    canonStatus: "protestant",
    theologicalCategory: null,
  };
}

function mockVerseText(
  canonicalId: string,
  translation: string,
  overrides: Partial<Pick<VerseText, "thematicTags" | "authorizedLevels">> = {},
): VerseText {
  return {
    canonicalId,
    translation,
    text: `mock-text-${canonicalId}-${translation}`,
    embeddingModel: null,
    thematicTags: overrides.thematicTags ?? [],
    culturalContext: null,
    humanReviewed: false,
    reviewedBy: null,
    authorizedLevels: overrides.authorizedLevels ?? ["public"],
  };
}

function mockOriginalWord(canonicalId: string, position: number): OriginalWord {
  return {
    canonicalId,
    position,
    lexeme: `mock-lexeme-${position}`,
    strongId: null,
    strongRaw: null,
    morphology: null,
    edition: null,
  };
}

function mockStrongsEntry(id: string, language: StrongsEntry["language"]): StrongsEntry {
  return {
    id,
    language,
    lemma: `mock-lemma-${id}`,
    transliteration: null,
    definition: `mock-definition-${id}`,
  };
}

function mockEdge(sourceId: string, targetId: string, kind: Edge["kind"] = "tsk"): Edge {
  return { sourceId, targetId, kind };
}

/** Embaralha de forma determinística por semente inteira (Fisher–Yates, RNG linear simples — só para o teste). */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  const nextRandom = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** Nenhum par distinto do array pode comparar igual (ordem TOTAL) — checagem O(n²), listas pequenas nos testes. */
function assertTotalOrder<T>(items: readonly T[], compare: (a: T, b: T) => number, label: (item: T) => string) {
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const a = items[i] as T;
      const b = items[j] as T;
      if (label(a) === label(b)) continue; // mesmos itens (identidade repetida de propósito) podem empatar
      expect(compare(a, b), `esperava diferença entre "${label(a)}" e "${label(b)}"`).not.toBe(0);
    }
  }
}

// --- chain / compareOrdinal --------------------------------------------------

describe("chain", () => {
  it("devolve o primeiro resultado não-zero", () => {
    expect(chain(0, 0, 5, -3)).toBe(5);
    expect(chain(-2, 7)).toBe(-2);
  });

  it("devolve 0 quando todos os resultados empatam", () => {
    expect(chain(0, 0, 0)).toBe(0);
    expect(chain()).toBe(0);
  });
});

describe("compareOrdinal", () => {
  it("compara por code unit UTF-16, não por locale", () => {
    expect(compareOrdinal("a", "b")).toBeLessThan(0);
    expect(compareOrdinal("b", "a")).toBeGreaterThan(0);
    expect(compareOrdinal("kjv", "kjv")).toBe(0);
    // "Z" (0x5A) < "a" (0x61) em ordem ordinal — diferente de collation locale-aware.
    expect(compareOrdinal("Z", "a")).toBeLessThan(0);
  });
});

// --- compareCanonicalRef / compareCanonicalId -------------------------------

describe("compareCanonicalRef", () => {
  it("ordena livros na ordem do cânon (USFM_BOOKS), não alfabética", () => {
    // "GEN" > "EXO" alfabeticamente, mas Gênesis vem antes de Êxodo no cânon.
    expect(compareCanonicalRef({ book: "GEN", chapter: 1, verse: 1 }, { book: "EXO", chapter: 1, verse: 1 })).toBeLessThan(0);
    expect(compareCanonicalRef({ book: "MAL", chapter: 1, verse: 1 }, { book: "MAT", chapter: 1, verse: 1 })).toBeLessThan(0);
    expect(compareCanonicalRef({ book: "REV", chapter: 1, verse: 1 }, { book: "GEN", chapter: 1, verse: 1 })).toBeGreaterThan(0);
  });

  it("dentro do mesmo livro, ordena por capítulo", () => {
    expect(compareCanonicalRef({ book: "PSA", chapter: 2, verse: 1 }, { book: "PSA", chapter: 3, verse: 1 })).toBeLessThan(0);
  });

  it("verso 0 (título de Salmo) ordena ANTES do verso 1 do mesmo capítulo", () => {
    expect(compareCanonicalRef({ book: "PSA", chapter: 3, verse: 0 }, { book: "PSA", chapter: 3, verse: 1 })).toBeLessThan(0);
  });

  it("referência idêntica compara igual", () => {
    expect(compareCanonicalRef({ book: "PSA", chapter: 3, verse: 1 }, { book: "PSA", chapter: 3, verse: 1 })).toBe(0);
  });

  it("explode em livro fora de USFM_BOOKS (defesa em profundidade, não deveria ocorrer com dado validado por Zod)", () => {
    const bogus = { book: "XXX" as UsfmBook, chapter: 1, verse: 1 };
    expect(() => compareCanonicalRef(bogus, { book: "GEN", chapter: 1, verse: 1 })).toThrow(/fora do cânon USFM_BOOKS/);
  });
});

describe("compareCanonicalId", () => {
  it("equivale a compareCanonicalRef a partir do id bruto", () => {
    expect(compareCanonicalId("GEN_1_1", "EXO_1_1")).toBeLessThan(0);
    expect(compareCanonicalId("PSA_3_0", "PSA_3_1")).toBeLessThan(0);
    expect(compareCanonicalId("PSA_3_1", "PSA_3_1")).toBe(0);
  });
});

// --- compareCanonicalVerse / propriedades totais ----------------------------

describe("compareCanonicalVerse", () => {
  const verses = [
    mockVerse("REV", 22, 21),
    mockVerse("GEN", 1, 1),
    mockVerse("PSA", 3, 0),
    mockVerse("PSA", 3, 1),
    mockVerse("PSA", 3, 2),
    mockVerse("PSA", 2, 12),
    mockVerse("MAT", 5, 39),
    mockVerse("MAL", 4, 6),
  ];

  it("é uma ordem total sobre o conjunto sintético (nenhum par distinto empata)", () => {
    assertTotalOrder(verses, compareCanonicalVerse, (v) => v.id);
  });

  it("produz a mesma ordenação independentemente da ordem de entrada (determinismo)", () => {
    const expectedOrder = ["GEN_1_1", "PSA_2_12", "PSA_3_0", "PSA_3_1", "PSA_3_2", "MAL_4_6", "MAT_5_39", "REV_22_21"];
    for (const seed of [1, 2, 3, 42, 999]) {
      const shuffled = shuffle(verses, seed);
      const sorted = sortDeterministic(shuffled, compareCanonicalVerse);
      expect(sorted.map((v) => v.id)).toEqual(expectedOrder);
    }
  });
});

// --- compareVerseText --------------------------------------------------------

describe("compareVerseText", () => {
  it("ordena por referência canônica e desempata por translation (ordinal, asc)", () => {
    const rows = [
      mockVerseText("GEN_1_1", "web"),
      mockVerseText("EXO_1_1", "kjv"),
      mockVerseText("GEN_1_1", "kjv"),
      mockVerseText("GEN_1_1", "blivre"),
    ];
    const sorted = sortDeterministic(rows, compareVerseText);
    expect(sorted.map((r) => `${r.canonicalId}:${r.translation}`)).toEqual([
      "GEN_1_1:blivre",
      "GEN_1_1:kjv",
      "GEN_1_1:web",
      "EXO_1_1:kjv",
    ]);
    assertTotalOrder(rows, compareVerseText, (r) => `${r.canonicalId}:${r.translation}`);
  });
});

// --- compareOriginalWord -----------------------------------------------------

describe("compareOriginalWord", () => {
  it("ordena por referência canônica e desempata por position (asc)", () => {
    const rows = [
      mockOriginalWord("GEN_1_1", 2),
      mockOriginalWord("EXO_1_1", 0),
      mockOriginalWord("GEN_1_1", 0),
      mockOriginalWord("GEN_1_1", 1),
    ];
    const sorted = sortDeterministic(rows, compareOriginalWord);
    expect(sorted.map((r) => `${r.canonicalId}:${r.position}`)).toEqual([
      "GEN_1_1:0",
      "GEN_1_1:1",
      "GEN_1_1:2",
      "EXO_1_1:0",
    ]);
    assertTotalOrder(rows, compareOriginalWord, (r) => `${r.canonicalId}:${r.position}`);
  });
});

// --- compareStrongsEntry ------------------------------------------------------

describe("compareStrongsEntry", () => {
  it("hebraico antes de grego, depois ordinal por id (zero-padded == numérico)", () => {
    const rows = [
      mockStrongsEntry("G0002", "greek"),
      mockStrongsEntry("H0430", "hebrew"),
      mockStrongsEntry("G0001", "greek"),
      mockStrongsEntry("H0001", "hebrew"),
    ];
    const sorted = sortDeterministic(rows, compareStrongsEntry);
    expect(sorted.map((r) => r.id)).toEqual(["H0001", "H0430", "G0001", "G0002"]);
    assertTotalOrder(rows, compareStrongsEntry, (r) => r.id);
  });
});

// --- compareEdge ---------------------------------------------------------------

describe("compareEdge", () => {
  it("ordena por sourceId, targetId, kind (nessa ordem)", () => {
    const rows = [
      mockEdge("GEN_1_1", "REV_1_1"),
      mockEdge("GEN_1_1", "JHN_1_1", "thematic"),
      mockEdge("GEN_1_1", "JHN_1_1", "tsk"),
      mockEdge("EXO_1_1", "GEN_1_1"),
    ];
    const sorted = sortDeterministic(rows, compareEdge);
    expect(sorted.map((r) => `${r.sourceId}->${r.targetId}:${r.kind}`)).toEqual([
      "GEN_1_1->JHN_1_1:tsk",
      "GEN_1_1->JHN_1_1:thematic",
      "GEN_1_1->REV_1_1:tsk",
      "EXO_1_1->GEN_1_1:tsk",
    ]);
  });
});

describe("sortDeterministicBy / edgeSortKeyOf / compareEdgeKey", () => {
  const edges = [
    mockEdge("GEN_1_1", "REV_1_1"),
    mockEdge("GEN_1_1", "JHN_1_1", "thematic"),
    mockEdge("GEN_1_1", "JHN_1_1", "tsk"),
    mockEdge("EXO_1_1", "GEN_1_1"),
  ];

  it("decorate-sort-undecorate produz exatamente a mesma ordem que compareEdge direto", () => {
    const viaCompareEdge = sortDeterministic(edges, compareEdge);
    const viaDecorated = sortDeterministicBy(edges, edgeSortKeyOf, compareEdgeKey);
    expect(viaDecorated).toEqual(viaCompareEdge);
  });

  it("é determinístico independentemente da ordem de entrada", () => {
    const expectedOrder = sortDeterministic(edges, compareEdge).map((e) => `${e.sourceId}->${e.targetId}:${e.kind}`);
    for (const seed of [1, 4, 8]) {
      const shuffled = shuffle(edges, seed);
      const sorted = sortDeterministicBy(shuffled, edgeSortKeyOf, compareEdgeKey);
      expect(sorted.map((e) => `${e.sourceId}->${e.targetId}:${e.kind}`)).toEqual(expectedOrder);
    }
  });
});

// --- writer: chaves fixas, LF, sem trailing space -----------------------------

describe("serializeJsonLine", () => {
  it("emite as chaves na ordem de keyOrder, não na ordem de inserção do objeto", () => {
    const record = { b: 2, a: 1, c: 3 };
    const line = serializeJsonLine(record, ["a", "b", "c"]);
    expect(line).toBe('{"a":1,"b":2,"c":3}');
  });

  it("explode se faltar chave prevista em keyOrder", () => {
    const record = { a: 1 } as { a: number; b: number };
    expect(() => serializeJsonLine(record, ["a", "b"])).toThrow(/ausente no registro/);
  });

  it("explode se houver chave não prevista em keyOrder", () => {
    const record = { a: 1, extra: 2 };
    expect(() => serializeJsonLine(record, ["a"])).toThrow(/não previstas em keyOrder/);
  });

  it("não produz espaço à direita (JSON.stringify compacto, sem indentação)", () => {
    const line = serializeJsonLine({ a: 1, b: "x " }, ["a", "b"]);
    expect(line.endsWith(" ")).toBe(false);
    expect(line).not.toContain(": ");
  });
});

describe("writeJsonl", () => {
  it("uma linha por registro, separadas por LF, terminadas por LF final", () => {
    const content = writeJsonl([{ a: 1 }, { a: 2 }], ["a"]);
    expect(content).toBe('{"a":1}\n{"a":2}\n');
    expect(content.includes("\r")).toBe(false);
  });

  it("lista vazia produz string vazia", () => {
    expect(writeJsonl([], ["a"])).toBe("");
  });
});

describe("writers por tabela: validam VALORES via Zod antes de gravar (fonte de verdade)", () => {
  it("writeCanonicalVerses recusa valor inválido mesmo com o shape de chaves correto", () => {
    // Tipo estático não prova o runtime: verse negativo passa no TS, nunca no Zod.
    const invalid = mockVerse("GEN", 1, -1);
    expect(() => writeCanonicalVerses([invalid])).toThrow(/canonical_verses.*registro 0 inválido/);
  });

  it("writeVerseTexts recusa translation vazia", () => {
    const invalid: VerseText = { ...mockVerseText("GEN_1_1", "kjv"), translation: "" };
    expect(() => writeVerseTexts([invalid])).toThrow(/verse_texts.*registro 0 inválido/);
  });
});

describe("writeVerseTexts: canonicaliza arrays-conjunto (thematicTags, authorizedLevels)", () => {
  it("ordena thematicTags e authorizedLevels ordinalmente, independente da ordem de inserção", () => {
    const row = mockVerseText("GEN_1_1", "kjv", {
      thematicTags: ["mock-tag-z", "mock-tag-a", "mock-tag-m"],
      authorizedLevels: ["curated", "public"],
    });
    const content = writeVerseTexts([row]);
    const parsed = JSON.parse(content.trimEnd()) as VerseText;
    expect(parsed.thematicTags).toEqual(["mock-tag-a", "mock-tag-m", "mock-tag-z"]);
    expect(parsed.authorizedLevels).toEqual(["public", "curated"].slice().sort());
  });

  it("byte a byte idêntico independente da ordem de inserção das tags de entrada", () => {
    const base = mockVerseText("GEN_1_1", "kjv");
    const variantA: VerseText = { ...base, thematicTags: ["mock-tag-z", "mock-tag-a"] };
    const variantB: VerseText = { ...base, thematicTags: ["mock-tag-a", "mock-tag-z"] };
    expect(writeVerseTexts([variantA])).toBe(writeVerseTexts([variantB]));
  });
});

// --- round-trip por tabela + estabilidade byte a byte -------------------------

describe("round-trip do writer (por tabela)", () => {
  it("canonical_verses: write → read devolve os mesmos registros", () => {
    const verses = [mockVerse("GEN", 1, 1), mockVerse("PSA", 3, 0), mockVerse("PSA", 3, 1)];
    const sorted = sortDeterministic(verses, compareCanonicalVerse);
    const content = writeCanonicalVerses(sorted);
    expect(readCanonicalVerses(content)).toEqual(sorted);
  });

  it("verse_texts: write → read devolve os mesmos registros", () => {
    const rows = sortDeterministic(
      [mockVerseText("GEN_1_1", "kjv"), mockVerseText("GEN_1_1", "web")],
      compareVerseText,
    );
    const content = writeVerseTexts(rows);
    expect(readVerseTexts(content)).toEqual(rows);
  });

  it("original_words: write → read devolve os mesmos registros", () => {
    const rows = sortDeterministic(
      [mockOriginalWord("GEN_1_1", 0), mockOriginalWord("GEN_1_1", 1)],
      compareOriginalWord,
    );
    const content = writeOriginalWords(rows);
    expect(readOriginalWords(content)).toEqual(rows);
  });

  it("strongs: write → read devolve os mesmos registros", () => {
    const rows = sortDeterministic([mockStrongsEntry("H0001", "hebrew"), mockStrongsEntry("G0001", "greek")], compareStrongsEntry);
    const content = writeStrongsEntries(rows);
    expect(readStrongsEntries(content)).toEqual(rows);
  });

  it("edges: write → read devolve os mesmos registros", () => {
    const rows = sortDeterministic([mockEdge("GEN_1_1", "JHN_1_1"), mockEdge("GEN_1_1", "REV_1_1")], compareEdge);
    const content = writeEdges(rows);
    expect(readEdges(content)).toEqual(rows);
  });

  it("readJsonl explode sem LF final (conteúdo malformado)", () => {
    expect(() => readCanonicalVerses('{"id":"GEN_1_1"}')).toThrow(/não termina com LF/);
  });

  it("readJsonl explode em linha que não valida contra o schema", () => {
    expect(() => readCanonicalVerses('{"id":"GEN_1_1","book":"GEN"}\n')).toThrow();
  });
});

describe("determinismo byte a byte: mesma entrada em ordens diferentes → mesma saída", () => {
  it("canonical_verses.jsonl é idêntico independente da ordem de entrada", () => {
    const verses = [
      mockVerse("REV", 22, 21),
      mockVerse("GEN", 1, 1),
      mockVerse("PSA", 3, 0),
      mockVerse("PSA", 3, 1),
      mockVerse("MAT", 5, 39),
      mockVerse("MAL", 4, 6),
    ];
    const outputs = [0, 1, 2, 7, 123].map((seed) => writeCanonicalVerses(sortDeterministic(shuffle(verses, seed), compareCanonicalVerse)));
    const [first, ...rest] = outputs;
    for (const output of rest) expect(output).toBe(first);
    expect(first).toMatchInlineSnapshot(`
      "{"id":"GEN_1_1","book":"GEN","chapter":1,"verse":1,"canonStatus":"protestant","theologicalCategory":null}
      {"id":"PSA_3_0","book":"PSA","chapter":3,"verse":0,"canonStatus":"protestant","theologicalCategory":null}
      {"id":"PSA_3_1","book":"PSA","chapter":3,"verse":1,"canonStatus":"protestant","theologicalCategory":null}
      {"id":"MAL_4_6","book":"MAL","chapter":4,"verse":6,"canonStatus":"protestant","theologicalCategory":null}
      {"id":"MAT_5_39","book":"MAT","chapter":5,"verse":39,"canonStatus":"protestant","theologicalCategory":null}
      {"id":"REV_22_21","book":"REV","chapter":22,"verse":21,"canonStatus":"protestant","theologicalCategory":null}
      "
    `);
  });

  it("verse_texts.jsonl é idêntico independente da ordem de entrada (pina bytes: mais campos, arrays, nullables)", () => {
    const rows = [
      mockVerseText("GEN_1_1", "web"),
      mockVerseText("GEN_1_1", "kjv", { thematicTags: ["mock-tag-z", "mock-tag-a"], authorizedLevels: ["curated", "public"] }),
      mockVerseText("EXO_1_1", "kjv"),
    ];
    const outputs = [0, 3, 11].map((seed) => writeVerseTexts(sortDeterministic(shuffle(rows, seed), compareVerseText)));
    const [first, ...rest] = outputs;
    for (const output of rest) expect(output).toBe(first);
    expect(first).toMatchInlineSnapshot(`
      "{"canonicalId":"GEN_1_1","translation":"kjv","text":"mock-text-GEN_1_1-kjv","embeddingModel":null,"thematicTags":["mock-tag-a","mock-tag-z"],"culturalContext":null,"humanReviewed":false,"reviewedBy":null,"authorizedLevels":["curated","public"]}
      {"canonicalId":"GEN_1_1","translation":"web","text":"mock-text-GEN_1_1-web","embeddingModel":null,"thematicTags":[],"culturalContext":null,"humanReviewed":false,"reviewedBy":null,"authorizedLevels":["public"]}
      {"canonicalId":"EXO_1_1","translation":"kjv","text":"mock-text-EXO_1_1-kjv","embeddingModel":null,"thematicTags":[],"culturalContext":null,"humanReviewed":false,"reviewedBy":null,"authorizedLevels":["public"]}
      "
    `);
  });

  it("original_words.jsonl é idêntico independente da ordem de entrada", () => {
    const rows = [mockOriginalWord("GEN_1_1", 1), mockOriginalWord("GEN_1_1", 0), mockOriginalWord("EXO_1_1", 0)];
    const outputs = [0, 4, 13].map((seed) => writeOriginalWords(sortDeterministic(shuffle(rows, seed), compareOriginalWord)));
    const [first, ...rest] = outputs;
    for (const output of rest) expect(output).toBe(first);
    expect(first).toMatchInlineSnapshot(`
      "{"canonicalId":"GEN_1_1","position":0,"lexeme":"mock-lexeme-0","strongId":null,"strongRaw":null,"morphology":null,"edition":null}
      {"canonicalId":"GEN_1_1","position":1,"lexeme":"mock-lexeme-1","strongId":null,"strongRaw":null,"morphology":null,"edition":null}
      {"canonicalId":"EXO_1_1","position":0,"lexeme":"mock-lexeme-0","strongId":null,"strongRaw":null,"morphology":null,"edition":null}
      "
    `);
  });

  it("strongs.jsonl é idêntico independente da ordem de entrada", () => {
    const rows = [mockStrongsEntry("G0002", "greek"), mockStrongsEntry("H0430", "hebrew"), mockStrongsEntry("H0001", "hebrew")];
    const outputs = [0, 6, 21].map((seed) => writeStrongsEntries(sortDeterministic(shuffle(rows, seed), compareStrongsEntry)));
    const [first, ...rest] = outputs;
    for (const output of rest) expect(output).toBe(first);
    expect(first).toMatchInlineSnapshot(`
      "{"id":"H0001","language":"hebrew","lemma":"mock-lemma-H0001","transliteration":null,"definition":"mock-definition-H0001"}
      {"id":"H0430","language":"hebrew","lemma":"mock-lemma-H0430","transliteration":null,"definition":"mock-definition-H0430"}
      {"id":"G0002","language":"greek","lemma":"mock-lemma-G0002","transliteration":null,"definition":"mock-definition-G0002"}
      "
    `);
  });

  it("edges.jsonl é idêntico independente da ordem de entrada", () => {
    const edges = [
      mockEdge("PSA_3_1", "GEN_1_1"),
      mockEdge("GEN_1_1", "JHN_1_1", "thematic"),
      mockEdge("GEN_1_1", "JHN_1_1", "tsk"),
      mockEdge("GEN_1_1", "REV_1_1"),
    ];
    const outputs = [0, 5, 9, 17].map((seed) => writeEdges(sortDeterministic(shuffle(edges, seed), compareEdge)));
    const [first, ...rest] = outputs;
    for (const output of rest) expect(output).toBe(first);
    expect(first).toMatchInlineSnapshot(`
      "{"sourceId":"GEN_1_1","targetId":"JHN_1_1","kind":"tsk"}
      {"sourceId":"GEN_1_1","targetId":"JHN_1_1","kind":"thematic"}
      {"sourceId":"GEN_1_1","targetId":"REV_1_1","kind":"tsk"}
      {"sourceId":"PSA_3_1","targetId":"GEN_1_1","kind":"tsk"}
      "
    `);
  });
});
