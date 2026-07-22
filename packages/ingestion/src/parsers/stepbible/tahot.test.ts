import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateHebrewVerses,
  parseTahot,
  parseTahotDetailed,
  TahotParseError,
} from "./tahot.js";

/**
 * Testes ancorados em requisito (ADR-008). Unit: linhas TSV SINTÉTICAS estruturais
 * (strings do vocabulário real — refs, dStrong, morfologia — não conteúdo teológico),
 * cobrindo as descobertas do dado real (§2 do plano + findings dos verifiers). Integração:
 * números EXATOS atrelados ao sha256 do manifest (pula quando a fonte falta, ADR-006;
 * NUNCA verde falso — rode com DATA_DIR do repo).
 */

/** Monta uma linha-por-palavra TAHOT com as 17 colunas fixas; só col 0/1/4/5 importam. */
function wordLine(
  col0: string,
  lexeme: string,
  dStrong: string,
  morph = "Ncfsa",
): string {
  const cols = new Array<string>(17).fill("");
  cols[0] = col0;
  cols[1] = lexeme;
  cols[2] = "translit"; // mock estrutural
  cols[3] = "gloss"; // mock estrutural
  cols[4] = dStrong;
  cols[5] = morph;
  return cols.join("\t");
}

describe("parseTahot — coluna de Strong (col 5) via N2 por segmento", () => {
  it("radical simples com prefixo gramatical (Gen.1.1#01: H9003/{H7225G} → H7225)", () => {
    const [row] = parseTahot(wordLine("Gen.1.1#01=L", "בְּ/רֵאשִׁ֖ית", "H9003/{H7225G}", "HR/Ncfsa"));
    expect(row).toEqual({
      canonicalId: "GEN_1_1",
      position: 1,
      lexeme: "בְּ/רֵאשִׁ֖ית",
      strongId: "H7225",
      strongRaw: "H9003/{H7225G}",
      morphology: "HR/Ncfsa",
      edition: "L",
    });
  });

  it("dStrong só-gramatical (H9xxx puro) → strongId null, strongRaw preservado", () => {
    const [row] = parseTahot(wordLine("Gen.1.1#01=L", "וְ", "H9002"));
    expect(row?.strongId).toBeNull();
    expect(row?.strongRaw).toBe("H9002");
  });

  it("FINDING: col 5 CONTÉM '\\' (pontuação) — split estende o N2 (H9009/{H0776G}\\H9016 → H0776)", () => {
    const [row] = parseTahot(wordLine("Gen.1.1#07=L", "הָ/אָֽרֶץ", "H9009/{H0776G}\\H9016"));
    expect(row?.strongId).toBe("H0776");
    expect(row?.strongRaw).toBe("H9009/{H0776G}\\H9016"); // bruto íntegro (Q2)
  });

  it("sufixo '+' (cobre a próxima palavra) é descartado ({H8423}+ → H8423)", () => {
    expect(parseTahot(wordLine("Gen.4.22#06=L", "תּוּבַל", "{H8423}+"))[0]?.strongId).toBe("H8423");
  });

  it("letra minúscula de desambiguação passa em UPPERCASE ao N2 ({H5838x} → H5838)", () => {
    const [row] = parseTahot(wordLine("2Ki.14.21#06=L", "עֲזַרְיָה", "{H5838x}"));
    expect(row?.strongId).toBe("H5838");
    expect(row?.strongRaw).toBe("{H5838x}"); // minúscula preservada no bruto
  });

  it("palavra multi-radical (maqqef) fica com o PRIMEIRO radical; bruto guarda todos", () => {
    const [row] = parseTahot(wordLine("Exo.4.2#04=Q(K)", "מַה־", "{H4100}/H9014/{H2088}"));
    expect(row?.strongId).toBe("H4100");
    expect(row?.strongRaw).toBe("{H4100}/H9014/{H2088}");
  });

  it("slot vazio '//' entre radicais é ignorado ({H0935G}//{H1409} → H0935)", () => {
    expect(parseTahot(wordLine("Gen.30.11#03=Q(K)", "בָּא", "{H0935G}//{H1409}"))[0]?.strongId).toBe("H0935");
  });
});

describe("parseTahot — carimbo de edição (TextType) e morfologia", () => {
  it("edition = TextType.raw; Qere com Ketiv carimbado carrega (Q4)", () => {
    expect(parseTahot(wordLine("Gen.1.1#01=Q(K)", "וְ", "{H1961}"))[0]?.edition).toBe("Q(K)");
  });

  it("morfologia crua preservada; vazia vira null", () => {
    expect(parseTahot(wordLine("Gen.1.1#01=L", "וְ", "{H1961}", "HVqp3ms"))[0]?.morphology).toBe("HVqp3ms");
    expect(parseTahot(wordLine("Gen.1.1#01=L", "וְ", "{H1961}", ""))[0]?.morphology).toBeNull();
  });
});

describe("parseTahot — position é sequência densa por canonical_id (chave única)", () => {
  it("palavra reconstruída LXX de 4 díg. entra na ordem de leitura, sem colidir", () => {
    // Ordem de arquivo real: #01, #02, #0201 (X), #03 → posições 1,2,3,4.
    const tsv = [
      wordLine("Gen.4.8#01=L", "וַ", "{H0559}"),
      wordLine("Gen.4.8#02=L", "קַיִן", "{H7014}"),
      wordLine("Gen.4.8#0201=X", "נֵלְכָה", "{H1980G}"),
      wordLine("Gen.4.8#03=L", "אֶל", "{H0413}"),
    ].join("\n");
    const rows = parseTahot(tsv);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.canonicalId === "GEN_4_8")).toBe(true);
    // A palavra LXX (#0201) ocupou a 3ª posição, entre #02 e #03.
    expect(rows[2]?.lexeme).toBe("נֵלְכָה");
    // Chave (canonicalId, position) única.
    expect(new Set(rows.map((r) => `${r.canonicalId}#${r.position}`)).size).toBe(rows.length);
  });

  it("verso inglês que agrega duas partes hebraicas (cada uma reinicia #01) não colide", () => {
    // Num.26.1 = fim de Heb 25.19 (#01..) + início de Heb 26.1 (#01..) — ambos KJV Num 26:1.
    const tsv = [
      wordLine("Num.26.1(25.19)#01=L", "וַ", "{H1961}"),
      wordLine("Num.26.1(25.19)#02=L", "אַחֲרֵי", "{H0310A}"),
      wordLine("Num.26.1#01=L", "וַ", "{H0559}"),
      wordLine("Num.26.1#02=L", "יְהוָה", "{H3068G}"),
    ].join("\n");
    const rows = parseTahot(tsv);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(new Set(rows.map((r) => `${r.canonicalId}#${r.position}`)).size).toBe(4);
  });
});

describe("parseTahot — skips com estatística e explosão de formato", () => {
  it("cabeçalho, licença e linhas-resumo '#' são ignorados (não são palavras)", () => {
    const tsv = [
      "TAHOT Gen-Deu - STEPBible.org CC BY.txt",
      "\t==============================================================",
      "# Gen.1.1\tבְּרֵאשִׁית\tinterlinear resumo",
      wordLine("Gen.1.1#01=L", "בְּ/רֵאשִׁ֖ית", "{H7225G}"),
    ].join("\n");
    const { rows, stats } = parseTahotDetailed(tsv);
    expect(rows).toHaveLength(1);
    expect(stats.wordLines).toBe(1);
    expect(stats.produced).toBe(1);
  });

  it("Qere que OMITE a palavra (lexeme vazio) é pulado com estatística, fora das rows", () => {
    const tsv = [
      wordLine("Jdg.16.25#01=L", "וַ", "{H1961}"),
      wordLine("Jdg.16.25#02=Q(K)", "", ""),
    ].join("\n");
    const { rows, stats } = parseTahotDetailed(tsv);
    expect(rows).toHaveLength(1);
    expect(stats.wordLines).toBe(2);
    expect(stats.skippedEmptyLexeme).toBe(1);
  });

  it("livro deuterocanônico (book=null) é pulado com estatística", () => {
    const { rows, stats } = parseTahotDetailed(wordLine("Sir.1.1#01=L", "כל", "{H3605}"));
    expect(rows).toHaveLength(0);
    expect(stats.skippedDeuterocanonical).toBe(1);
  });

  it("EXPLODE com número da linha em ref malformada (livro desconhecido)", () => {
    const tsv = [
      wordLine("Gen.1.1#01=L", "וְ", "{H1961}"),
      wordLine("Gen.1.2#01=L", "וְ", "{H1961}"),
      wordLine("Xyz.1.1#01=L", "וְ", "{H1961}"),
    ].join("\n");
    expect(() => parseTahot(tsv)).toThrow(TahotParseError);
    expect(() => parseTahot(tsv)).toThrow(/TAHOT linha 3/);
  });

  it("EXPLODE com número da linha em contagem de colunas inesperada", () => {
    expect(() => parseTahot("Gen.1.1#01=L\tsó-duas-colunas")).toThrow(/linha 1:.*17 colunas/);
  });

  it("EXPLODE com número da linha em dStrong fora do vocabulário fechado", () => {
    expect(() => parseTahot(wordLine("Gen.1.1#01=L", "וְ", "X0001"))).toThrow(/linha 1:.*dStrong/);
  });

  it("dStrong ruim após cabeçalho aponta a linha REAL do arquivo (2), não a posição pós-skip (1)", () => {
    // A linha-palavra é a 2ª do arquivo; como o cabeçalho é pulado, ela seria a 1ª no array
    // filtrado. O erro do dStrong deve citar a linha 2 (origem real), não a 1 (índice filtrado).
    const tsv = [
      "TAHOT Gen-Deu - STEPBible.org CC BY 4.0", // linha 1: cabeçalho, pulada
      wordLine("Gen.1.1#01=L", "וְ", "X0001"), // linha 2: dStrong fora do vocabulário
    ].join("\n");
    expect(() => parseTahot(tsv)).toThrow(/TAHOT linha 2:.*dStrong/);
  });
});

describe("aggregateHebrewVerses — insumo do gate hebraico (N5)", () => {
  it("título de Salmo: ref hebraica conta o título (v.1 heb), isTitle=true", () => {
    const tsv = [
      wordLine("Psa.3.0(3.1)#01=L", "מִזְמוֹר", "{H4210}"),
      wordLine("Psa.3.0(3.1)#02=L", "לְ/דָוִד", "H9005/{H1732}"),
      wordLine("Psa.3.1(3.2)#01=L", "יְהוָה", "{H3068G}"),
    ].join("\n");
    const agg = aggregateHebrewVerses(tsv);
    expect(agg).toEqual([
      { bookCode: "Psa", chapter: 3, verse: 1, wordCount: 2, isTitle: true },
      { bookCode: "Psa", chapter: 3, verse: 2, wordCount: 1, isTitle: false },
    ]);
  });

  it("Malaquias: KJV cap.4 → ref hebraica cap.3 (Mal.4.1(3.19) agrega em Mal 3:19 heb)", () => {
    const agg = aggregateHebrewVerses(
      [
        wordLine("Mal.4.1(3.19)#01=L", "כִּי", "{H3588A}"),
        wordLine("Mal.4.1(3.19)#02=L", "הִנֵּה", "{H2009}"),
      ].join("\n"),
    );
    expect(agg).toEqual([{ bookCode: "Mal", chapter: 3, verse: 19, wordCount: 2, isTitle: false }]);
  });

  it("sem parênteses: hebraico == primária (Gen 1:1)", () => {
    const agg = aggregateHebrewVerses(wordLine("Gen.1.1#01=L", "בְּ/רֵאשִׁ֖ית", "{H7225G}"));
    expect(agg).toEqual([{ bookCode: "Gen", chapter: 1, verse: 1, wordCount: 1, isTitle: false }]);
  });
});

/* ─── Integração contra as 4 fontes TAHOT reais (fora do Git — ADR-006) ─────────────── */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", "stepbible-tahot", rel);

/** Números EXATOS atrelados ao sha256 do manifest (commit 0f60797…). Provados no dado. */
const TAHOT_FILES = [
  { file: "TAHOT_Gen-Deu.txt", wordLines: 79990, produced: 79990, emptyLexeme: 0 },
  { file: "TAHOT_Jos-Est.txt", wordLines: 107259, produced: 107252, emptyLexeme: 7 },
  { file: "TAHOT_Job-Sng.txt", wordLines: 39090, produced: 39090, emptyLexeme: 0 },
  { file: "TAHOT_Isa-Mal.txt", wordLines: 79313, produced: 79306, emptyLexeme: 7 },
] as const;

const TOTAL_WORD_LINES = 305652;
const TOTAL_PRODUCED = 305638;
const TOTAL_EMPTY_LEXEME = 14;

const hasAllFiles = TAHOT_FILES.every((f) => existsSync(src(f.file)));

describe.skipIf(!hasAllFiles)("TAHOT real — números exatos atrelados ao manifest", () => {
  it("contagens por arquivo (wordLines, produced, emptyLexeme, 0 deuterocanônicos)", () => {
    for (const f of TAHOT_FILES) {
      const { rows, stats } = parseTahotDetailed(readFileSync(src(f.file), "utf8"));
      expect(stats.wordLines, f.file).toBe(f.wordLines);
      expect(stats.produced, f.file).toBe(f.produced);
      expect(rows.length, f.file).toBe(f.produced);
      expect(stats.skippedEmptyLexeme, f.file).toBe(f.emptyLexeme);
      expect(stats.skippedDeuterocanonical, f.file).toBe(0); // TAHOT = 39 livros canônicos
    }
  });

  it("totais das 4 fontes: 305 652 linhas-palavra, 305 638 produzidas, 14 Qere-omitidos", () => {
    let wordLines = 0;
    let produced = 0;
    let emptyLexeme = 0;
    for (const f of TAHOT_FILES) {
      const { stats } = parseTahotDetailed(readFileSync(src(f.file), "utf8"));
      wordLines += stats.wordLines;
      produced += stats.produced;
      emptyLexeme += stats.skippedEmptyLexeme;
    }
    expect(wordLines).toBe(TOTAL_WORD_LINES);
    expect(produced).toBe(TOTAL_PRODUCED);
    expect(emptyLexeme).toBe(TOTAL_EMPTY_LEXEME);
  });

  it("(canonical_id, position) é chave ÚNICA em cada arquivo (determinismo, sem colisão)", () => {
    for (const f of TAHOT_FILES) {
      const rows = parseTahot(readFileSync(src(f.file), "utf8"));
      const keys = new Set(rows.map((r) => `${r.canonicalId}#${r.position}`));
      expect(keys.size, f.file).toBe(rows.length);
    }
  });

  it("amostra Gn 1:1 — primeira palavra tageada corretamente", () => {
    const raw = readFileSync(src("TAHOT_Gen-Deu.txt"), "utf8");
    const rows = parseTahot(raw);
    const first = rows.find((r) => r.canonicalId === "GEN_1_1" && r.position === 1);
    expect(first).toMatchObject({
      canonicalId: "GEN_1_1",
      position: 1,
      strongId: "H7225",
      strongRaw: "H9003/{H7225G}",
      morphology: "HR/Ncfsa",
      edition: "L",
    });
    // Lexeme comparado ao col 2 cru da própria fonte (evita fragilidade de
    // normalização Unicode de literal): prova passagem fiel do hebraico apontado.
    const rawCol2 = (raw.split("\n").find((l) => l.startsWith("Gen.1.1#01=L")) ?? "").split("\t")[1];
    expect(first?.lexeme).toBe(rawCol2);
    expect(first?.lexeme.length).toBeGreaterThan(0);
    // Gn 1:1 tem 7 palavras ortográficas → posições 1..7.
    const gen11 = rows.filter((r) => r.canonicalId === "GEN_1_1");
    expect(gen11.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("agregação hebraica real: Gn 1:1 = 7 palavras; título do Sl 3 (heb 3:1) = 6, isTitle", () => {
    const gen = aggregateHebrewVerses(readFileSync(src("TAHOT_Gen-Deu.txt"), "utf8"));
    expect(gen.find((v) => v.bookCode === "Gen" && v.chapter === 1 && v.verse === 1)).toEqual({
      bookCode: "Gen",
      chapter: 1,
      verse: 1,
      wordCount: 7,
      isTitle: false,
    });
    const psalms = aggregateHebrewVerses(readFileSync(src("TAHOT_Job-Sng.txt"), "utf8"));
    expect(psalms.find((v) => v.bookCode === "Psa" && v.chapter === 3 && v.verse === 1)).toEqual({
      bookCode: "Psa",
      chapter: 3,
      verse: 1,
      wordCount: 6,
      isTitle: true,
    });
  });
});
