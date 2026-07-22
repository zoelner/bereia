import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  editionIncludesNa,
  editionIncludesTr,
  parseTagnt,
  parseTagntFile,
} from "./tagnt.js";
import type { TaggedWordRow } from "./types.js";

/**
 * Testes ancorados em requisito (ADR-008). O bloco unitário exercita a ESTRUTURA do parser
 * com linhas TSV sintéticas (strings de código/carimbo, não conteúdo teológico) e os caminhos
 * de explosão. O bloco de integração roda contra os 2 arquivos TAGNT REAIS (fora do Git —
 * ADR-006; `skipIf` quando ausentes, nunca verde falso) e trava números EXATOS atrelados ao
 * sha256 do manifest, incluindo o caso-ouro de At 8:37 (decisão Q3 do plano).
 */

// Linha de palavra sintética mínima: o parser lê col1, col2 (grego) e col4 (dStrong=Grammar).
function wordLine(col1: string, greek: string, dStrongGrammar: string, gloss = "gloss"): string {
  return [col1, greek, gloss, dStrongGrammar].join("\t");
}

describe("parseTagnt — estrutura (linhas sintéticas)", () => {
  it("linha de palavra simples NKO → TaggedWordRow completa", () => {
    const [row] = parseTagnt(wordLine("Mat.1.1#01=NKO", "Βίβλος (Biblos)", "G0976=N-NSF"));
    expect(row).toEqual({
      canonicalId: "MAT_1_1",
      position: 1,
      lexeme: "Βίβλος (Biblos)",
      strongId: "G0976",
      strongRaw: "G0976",
      morphology: "N-NSF",
      edition: "NKO",
    } satisfies TaggedWordRow);
  });

  it("letra de desambiguação no dStrong some no strongId, mas fica em strongRaw (G2384H → G2384)", () => {
    const [row] = parseTagnt(wordLine("Mat.1.2#09=NKO", "Ἰακώβ (Iakōb)", "G2384H=N-ASM-P"));
    expect(row?.strongId).toBe("G2384");
    expect(row?.strongRaw).toBe("G2384H");
  });

  it("Strong estendido do STEPBible (≥5 díg.) → strongId null, strongRaw preserva o bruto", () => {
    const [row] = parseTagnt(wordLine("Act.24.12#12=N(k)O", "ἐπίστασιν (epistasin)", "G20447=N-ASF"));
    expect(row?.strongId).toBeNull();
    expect(row?.strongRaw).toBe("G20447");
    expect(row?.morphology).toBe("N-ASF");
  });

  it("tag gramatical G9xxx → strongId null (via N2), strongRaw preserva", () => {
    const [row] = parseTagnt(wordLine("Act.7.26#09=N(K)O", "συνήλλασσεν (synēllassen)", "G9996=V-IAI-3S"));
    expect(row?.strongId).toBeNull();
    expect(row?.strongRaw).toBe("G9996");
  });

  it("canonical_id vem do colchete [KJV], não da ref primária NRSV (2Co.13.13[13.14] → 2CO_13_14)", () => {
    const [row] = parseTagnt(wordLine("2Co.13.13[13.14]#22=K", "χάρις (charis)", "G5485=N-NSF"));
    expect(row?.canonicalId).toBe("2CO_13_14");
    expect(row?.edition).toBe("K");
  });

  it("carimba o WordType cru em edition (N(k)O preservado literal)", () => {
    const [row] = parseTagnt(wordLine("Mat.1.10#10=N(k)O", "Ἀμών (Amōn)", "G0301H=N-ASM-P"));
    expect(row?.edition).toBe("N(k)O");
  });

  it("pula cabeçalho/sumário/vazias e conta em skippedNonWord (sem emitir linha)", () => {
    const tsv = [
      "TAGNT Mat-Jhn - Translators Amalgamated Greek NT -  STEPBible.org CC BY 4.0",
      "\t=============",
      "#_Translation\t[The] book\tof [the] genealogy",
      "#_Word=Grammar\tG0976=N-NSF\tG1078=N-GSF",
      "",
      wordLine("Mat.1.1#01=NKO", "Βίβλος (Biblos)", "G0976=N-NSF"),
      wordLine("Mat.1.1#02=NKO", "γενέσεως (geneseōs)", "G1078=N-GSF"),
    ].join("\n");
    const { rows, stats } = parseTagntFile(tsv);
    expect(rows).toHaveLength(2);
    expect(stats.words).toBe(2);
    expect(stats.skippedNonWord).toBe(5);
  });

  it("preserva a ordem do arquivo e as posições (#01, #02) — determinismo", () => {
    const tsv = [
      wordLine("Jhn.3.16#03=NKO", "ἠγάπησεν (ēgapēsen)", "G0025=V-AAI-3S"),
      wordLine("Jhn.3.16#04=NKO", "ὁ (ho)", "G3588=T-NSM"),
    ].join("\n");
    const rows = parseTagnt(tsv);
    expect(rows.map((r) => r.position)).toEqual([3, 4]);
    expect(rows.map((r) => r.canonicalId)).toEqual(["JHN_3_16", "JHN_3_16"]);
  });

  it("EXPLODE (com nº de linha) numa linha de palavra sem grego (col 2 vazia)", () => {
    const tsv = ["cabeçalho", "Mat.1.1#01=NKO\t\tgloss\tG0976=N-NSF"].join("\n");
    expect(() => parseTagnt(tsv)).toThrow(/TAGNT linha 2:.*col 2/);
  });

  it("EXPLODE (com nº de linha) num dStrong fora do vocabulário fechado (col 4 = GXYZ)", () => {
    const tsv = [wordLine("Mat.1.1#01=NKO", "Βίβλος (Biblos)", "GXYZ=N-NSF")].join("\n");
    expect(() => parseTagnt(tsv)).toThrow(/TAGNT linha 1:/);
  });

  it("EXPLODE numa col 1 com assinatura de palavra mas WordType desconhecido (=NA)", () => {
    const tsv = [wordLine("Mat.1.1#01=NA", "Βίβλος (Biblos)", "G0976=N-NSF")].join("\n");
    expect(() => parseTagnt(tsv)).toThrow(/TAGNT linha 1:/);
  });

  it("EXPLODE num dStrong H de 5+ dígitos em contexto grego (idioma errado, não é 'estendido')", () => {
    // EXTENDED_STRONG ficou restrito a G\d{5,}: um H\d{5,} não é mais absorvido em silêncio
    // como Strong estendido — cai em normalizeStrong(_, "greek") e explode por idioma errado.
    const tsv = [wordLine("Mat.1.1#01=NKO", "Βίβλος (Biblos)", "H99999=N-NSF")].join("\n");
    expect(() => parseTagnt(tsv)).toThrow(/TAGNT linha 1/);
  });
});

describe("projeções de edição TR/NA (K/N ∈ WordType)", () => {
  it("editionIncludesTr: K/k presente ⇒ TR", () => {
    expect(editionIncludesTr("NKO")).toBe(true); // firme
    expect(editionIncludesTr("KO")).toBe(true); // TR sem NA
    expect(editionIncludesTr("N(k)O")).toBe(true); // variante minúscula ainda é TR
    expect(editionIncludesTr("K")).toBe(true); // só-TR
    expect(editionIncludesTr("no")).toBe(false); // NA+Other, sem TR
    expect(editionIncludesTr("N(O)")).toBe(false);
  });

  it("editionIncludesNa: N/n presente ⇒ NA", () => {
    expect(editionIncludesNa("NKO")).toBe(true);
    expect(editionIncludesNa("KO")).toBe(false); // TR+Other, sem NA
    expect(editionIncludesNa("no")).toBe(true);
    expect(editionIncludesNa("K")).toBe(false);
  });
});

// ── Integração contra os arquivos TAGNT reais (fora do Git; skipIf) ───────────────────────
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", rel);

const MAT_JHN = src("stepbible-tagnt/TAGNT_Mat-Jhn.txt");
const ACT_REV = src("stepbible-tagnt/TAGNT_Act-Rev.txt");
const hasFiles = existsSync(MAT_JHN) && existsSync(ACT_REV);

/** sha256 pinado no manifest — âncora dos números exatos abaixo (ADR-008). */
const MANIFEST_SHA256: Record<string, string> = {
  [MAT_JHN]: "ab8eaaeb68e17a1dcfa34e1e9350358f22f03bc2a97244d848750ad81044bc8e",
  [ACT_REV]: "524e32375361e6d3fa2f7ef00b87605fdc4317a762f395651a05fdc31ad031b7",
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Todas as palavras (canonical) com dado canonical_id. */
function wordsOf(rows: readonly TaggedWordRow[], canonicalId: string): TaggedWordRow[] {
  return rows.filter((r) => r.canonicalId === canonicalId);
}

describe.skipIf(!hasFiles)("TAGNT real — 2 arquivos pinados (manifest sha256)", () => {
  let matJhn: TaggedWordRow[];
  let actRev: TaggedWordRow[];

  beforeAll(() => {
    // Guarda de âncora: se o arquivo divergir do manifest, os números abaixo não valem.
    for (const file of [MAT_JHN, ACT_REV]) {
      expect(sha256(file), `sha256 de ${path.basename(file)} != manifest`).toBe(
        MANIFEST_SHA256[file],
      );
    }
    matJhn = parseTagnt(readFileSync(MAT_JHN, "utf8"));
    actRev = parseTagnt(readFileSync(ACT_REV, "utf8"));
  });

  it("nº EXATO de palavras por arquivo (atrelado ao sha256)", () => {
    expect(matJhn).toHaveLength(66984);
    expect(actRev).toHaveLength(75112);
    expect(matJhn.length + actRev.length).toBe(142096);
  });

  it("toda linha vira canonical_id válido e toda edition tem carimbo não-vazio", () => {
    for (const rows of [matJhn, actRev]) {
      for (const r of rows) {
        expect(r.canonicalId).toMatch(/^[A-Z0-9]{3}_\d{1,3}_\d{1,3}$/);
        expect(r.edition && r.edition.length).toBeGreaterThan(0);
      }
    }
  });

  it("distribuição EXATA por presença de edição (TR/NA), atrelada ao manifest", () => {
    const dist = (rows: readonly TaggedWordRow[]) => {
      let tr = 0;
      let na = 0;
      let trOnly = 0;
      let naOnly = 0;
      for (const r of rows) {
        const hasTr = editionIncludesTr(r.edition ?? "");
        const hasNa = editionIncludesNa(r.edition ?? "");
        if (hasTr) tr++;
        if (hasNa) na++;
        if (hasTr && !hasNa) trOnly++;
        if (hasNa && !hasTr) naOnly++;
      }
      return { tr, na, trOnly, naOnly };
    };
    expect(dist(matJhn)).toEqual({ tr: 66364, na: 64393, trOnly: 2424, naOnly: 453 });
    expect(dist(actRev)).toEqual({ tr: 74553, na: 73253, trOnly: 1742, naOnly: 442 });
  });

  it("os 3 Strong estendidos (≥5 díg.) reais → strongId null, strongRaw preservado", () => {
    const extended = actRev.filter((r) => r.strongRaw !== null && /^[HG]\d{5,}/.test(r.strongRaw));
    expect(extended).toHaveLength(3);
    expect(new Set(extended.map((r) => r.strongRaw))).toEqual(new Set(["G20447", "G20833"]));
    for (const r of extended) expect(r.strongId).toBeNull();
  });

  /**
   * CASO-OURO At 8:37 (decisão Q3). Investigação empírica no dado real: a ref `Act.8.37`
   * NÃO some — aparece como ref PRIMÁRIA (`Act.8.37#01..23=K`), com as 23 palavras todas
   * carimbadas `K` (só-TR). Logo ACT_8_37 RECEBE original_words (23), todas Textus Receptus,
   * nenhuma em NA. Não há lacuna: BLIVRE/KJV (TR) têm o verso COM original_words.
   */
  it("At 8:37 (Q3): ACT_8_37 recebe 23 palavras, todas só-TR (K), nenhuma em NA", () => {
    const words = wordsOf(actRev, "ACT_8_37");
    expect(words).toHaveLength(23);
    for (const r of words) {
      expect(r.edition).toBe("K");
      expect(editionIncludesTr(r.edition ?? "")).toBe(true);
      expect(editionIncludesNa(r.edition ?? "")).toBe(false);
      expect(r.strongId).not.toBeNull(); // as 23 têm Strong lexical de 4 díg.
    }
    expect(words[0]?.position).toBe(1);
    expect(words[words.length - 1]?.position).toBe(23);
  });

  it("At 8:37 fica entre 8:36 e 8:38, sem colchete [8.37] (ref primária é a própria 8.37)", () => {
    expect(wordsOf(actRev, "ACT_8_36").length).toBeGreaterThan(0);
    expect(wordsOf(actRev, "ACT_8_38").length).toBeGreaterThan(0);
    // não existe canonical 8.37 vindo de bracket em 8.36: todas as 23 são ref primária direta
    expect(wordsOf(actRev, "ACT_8_37")).toHaveLength(23);
  });

  it("2Co 13:14 (bênção final só-TR via colchete): 2CO_13_14 recebe 33 palavras", () => {
    const words = wordsOf(actRev, "2CO_13_14");
    expect(words).toHaveLength(33);
  });

  it("3Jn: NRSV 1.14 e 1.15 colapsam no KJV 1.14 — 3JN_1_14 tem 21 palavras, 3JN_1_15 não existe", () => {
    expect(wordsOf(actRev, "3JN_1_14")).toHaveLength(21); // 10 (1.14) + 11 (1.15[1.14])
    expect(wordsOf(actRev, "3JN_1_15")).toHaveLength(0);
  });

  it("Rom 16:24 (verso só-TR ausente no NA): 11 palavras, todas KO (TR sim, NA não)", () => {
    const words = wordsOf(actRev, "ROM_16_24");
    expect(words).toHaveLength(11);
    for (const r of words) {
      expect(r.edition).toBe("KO");
      expect(editionIncludesTr(r.edition ?? "")).toBe(true);
      expect(editionIncludesNa(r.edition ?? "")).toBe(false);
    }
  });

  it("amostra Mat 1:1 #01 — strongId/morfologia/edição corretos no dado real", () => {
    const first = matJhn[0];
    expect(first).toMatchObject({
      canonicalId: "MAT_1_1",
      position: 1,
      strongId: "G0976",
      strongRaw: "G0976",
      morphology: "N-NSF",
      edition: "NKO",
    });
    // O grego do STEPBible vem em NFD (acentos decompostos); comparo por NFC + transliteração.
    expect(first?.lexeme.normalize("NFC")).toContain("Βίβλος");
    expect(first?.lexeme).toContain("(Biblos)");
  });
});
