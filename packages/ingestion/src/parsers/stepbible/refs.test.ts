import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTagntRef, parseTahotRef, stepCanonicalRef } from "./refs.js";
import { tvtmsBookToUsfm } from "../tvtms/books.js";

/**
 * Testes ancorados em requisito (ADR-008): a notação da col 1 do STEPBible é contrato
 * externo. Casos baseados nas evidências de docs/plano-stepbible.md §2 (strings
 * estruturais — códigos de ref, não conteúdo teológico) + casos de explosão.
 */

describe("parseTahotRef", () => {
  it("ref simples KJV==hebraico (Gen.1.1#01=L)", () => {
    expect(parseTahotRef("Gen.1.1#01=L")).toEqual({
      source: "tahot",
      book: "GEN",
      bookCode: "Gen",
      chapter: 1,
      verse: 1,
      hebrew: null,
      position: 1,
      textType: "L",
    });
  });

  it("título de Salmo = verso 0, hebraico conta o título como v.1 (Psa.3.0(3.1)#01=L)", () => {
    expect(parseTahotRef("Psa.3.0(3.1)#01=L")).toMatchObject({
      book: "PSA",
      chapter: 3,
      verse: 0,
      hebrew: { chapter: 3, verse: 1 },
    });
  });

  it("Malaquias KJV cap.4, hebraico cap.3 (Mal.4.1(3.19) e Mal.4.6(3.24))", () => {
    expect(parseTahotRef("Mal.4.1(3.19)#01=L").hebrew).toEqual({ chapter: 3, verse: 19 });
    expect(parseTahotRef("Mal.4.6(3.24)#02=L")).toMatchObject({
      book: "MAL",
      chapter: 4,
      verse: 6,
      hebrew: { chapter: 3, verse: 24 },
    });
  });

  it("Joel: inglês 3 caps., hebraico 4 (Jol.2.28(3.1) e Jol.3.1(4.1))", () => {
    expect(parseTahotRef("Jol.2.28(3.1)#03=L")).toMatchObject({
      book: "JOL",
      chapter: 2,
      verse: 28,
      hebrew: { chapter: 3, verse: 1 },
    });
    expect(parseTahotRef("Jol.3.1(4.1)#01=Q").hebrew).toEqual({ chapter: 4, verse: 1 });
  });

  it("aceita todo TextType do vocabulário fechado (L/Q/K/R/X)", () => {
    for (const t of ["L", "Q", "K", "R", "X"] as const) {
      expect(parseTahotRef(`Gen.1.1#01=${t}`).textType).toBe(t);
    }
  });

  it("livro deuterocanônico conhecido sinaliza skip (book=null), não explode", () => {
    expect(parseTahotRef("Sir.1.1#01=L").book).toBeNull();
  });

  it("posição multi-dígito preserva o valor (Psa.119.176#10=L)", () => {
    expect(parseTahotRef("Psa.119.176#10=L")).toMatchObject({ chapter: 119, verse: 176, position: 10 });
  });

  it("EXPLODE em TextType fora do vocabulário (Gen.1.1#01=Z)", () => {
    expect(() => parseTahotRef("Gen.1.1#01=Z")).toThrow(/TextType desconhecido/);
  });

  it("EXPLODE em código de livro desconhecido (Xyz.1.1#01=L)", () => {
    expect(() => parseTahotRef("Xyz.1.1#01=L")).toThrow(/desconhecido/);
  });

  it("EXPLODE em ref malformada sem verso (Gen.1#01=L)", () => {
    expect(() => parseTahotRef("Gen.1#01=L")).toThrow(/inválida/);
  });

  it("EXPLODE quando a posição não é numérica (Gen.1.1#a=L)", () => {
    expect(() => parseTahotRef("Gen.1.1#a=L")).toThrow(/inválida/);
  });
});

describe("parseTagntRef", () => {
  it("ref sem colchete: NRSV==KJV, palavra firme nas três edições (Mat.1.1#01=NKO)", () => {
    expect(parseTagntRef("Mat.1.1#01=NKO")).toEqual({
      source: "tagnt",
      book: "MAT",
      bookCode: "Mat",
      chapter: 1,
      verse: 1,
      kjv: null,
      na: null,
      other: null,
      position: 1,
      wordType: { raw: "NKO", na: "firm", tr: "firm", other: "firm" },
    });
  });

  it("colchete [KJV] quando NRSV difere: bênção final só-TR (2Co.13.13[13.14]#22=K)", () => {
    const ref = parseTagntRef("2Co.13.13[13.14]#22=K");
    expect(ref).toMatchObject({
      book: "2CO",
      chapter: 13,
      verse: 13,
      kjv: { chapter: 13, verse: 14 },
      position: 22,
      wordType: { raw: "K", na: null, tr: "firm", other: null },
    });
  });

  it("colchete [KJV] com numeração menor (3Jn.1.15[1.14]#05=NKO)", () => {
    expect(parseTagntRef("3Jn.1.15[1.14]#05=NKO").kjv).toEqual({ chapter: 1, verse: 14 });
  });

  it("verso só-TR ausente no NA (Rom.16.24#01=KO)", () => {
    expect(parseTagntRef("Rom.16.24#01=KO").wordType).toEqual({
      raw: "KO",
      na: null,
      tr: "firm",
      other: "firm",
    });
  });

  it("variante entre parênteses no WordType (N(k)O → tr=variant)", () => {
    expect(parseTagntRef("Jhn.1.1#01=N(k)O").wordType).toEqual({
      raw: "N(k)O",
      na: "firm",
      tr: "variant",
      other: "firm",
    });
  });

  it("letras minúsculas são variantes (no → na/other variant)", () => {
    expect(parseTagntRef("Jhn.1.1#02=no").wordType).toEqual({
      raw: "no",
      na: "variant",
      tr: null,
      other: "variant",
    });
  });

  it("variante TR isolada (k)", () => {
    expect(parseTagntRef("Jhn.1.1#03=k").wordType).toMatchObject({ tr: "variant", na: null, other: null });
  });

  it("EXPLODE em letra de edição desconhecida (=NA)", () => {
    expect(() => parseTagntRef("Mat.1.1#01=NA")).toThrow(/letra de edição desconhecida/);
  });

  it("EXPLODE em edição repetida (=NN)", () => {
    expect(() => parseTagntRef("Mat.1.1#01=NN")).toThrow(/repetida/);
  });

  it("EXPLODE em WordType vazio (=)", () => {
    expect(() => parseTagntRef("Mat.1.1#01=")).toThrow(/vazio/);
  });

  it("EXPLODE sem o marcador #Pos", () => {
    expect(() => parseTagntRef("Mat.1.1=NKO")).toThrow(/inválida/);
  });

  it("EXPLODE em sobra não reconhecida após a ref primária", () => {
    expect(() => parseTagntRef("Mat.1.1x#01=NKO")).toThrow(/sobra não reconhecida/);
  });

  it("EXPLODE em código de livro desconhecido", () => {
    expect(() => parseTagntRef("Xyz.1.1#01=NKO")).toThrow(/desconhecido/);
  });
});

describe("stepCanonicalRef (produtor comum do canonical_id, plano §3.1)", () => {
  it("TAHOT usa a ref primária (já KJV), inclusive título v.0", () => {
    expect(stepCanonicalRef(parseTahotRef("Psa.3.0(3.1)#01=L"))).toEqual({
      book: "PSA",
      chapter: 3,
      verse: 0,
    });
    expect(stepCanonicalRef(parseTahotRef("Mal.4.1(3.19)#01=L"))).toEqual({
      book: "MAL",
      chapter: 4,
      verse: 1,
    });
  });

  it("TAGNT prefere o colchete [KJV] (2Co 13:14), com fallback à primária", () => {
    expect(stepCanonicalRef(parseTagntRef("2Co.13.13[13.14]#22=K"))).toEqual({
      book: "2CO",
      chapter: 13,
      verse: 14,
    });
    expect(stepCanonicalRef(parseTagntRef("Mat.1.1#01=NKO"))).toEqual({
      book: "MAT",
      chapter: 1,
      verse: 1,
    });
  });

  it("livro deuterocanônico → null (pular)", () => {
    expect(stepCanonicalRef(parseTahotRef("Sir.1.1#01=L"))).toBeNull();
  });
});

/**
 * Integração contra as FONTES REAIS (data/sources/, fora do Git — ADR-006; pula quando
 * ausentes, nunca verde falso). Prova o vocabulário de códigos de livro: TODO código na
 * col 1 dos 6 arquivos mapeia via tabela USFM (canônico ou deuterocanônico), sem explodir.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const STEP_FILES = [
  "stepbible-tahot/TAHOT_Gen-Deu.txt",
  "stepbible-tahot/TAHOT_Jos-Est.txt",
  "stepbible-tahot/TAHOT_Job-Sng.txt",
  "stepbible-tahot/TAHOT_Isa-Mal.txt",
  "stepbible-tagnt/TAGNT_Mat-Jhn.txt",
  "stepbible-tagnt/TAGNT_Act-Rev.txt",
].map((rel) => path.join(dataDir, "sources", rel));
const hasAllFiles = STEP_FILES.every((f) => existsSync(f));

/** Extrai o código de livro (antes do 1º ".") das linhas-por-palavra (col 1 tem "#Pos="). */
function bookCodesOf(content: string): Set<string> {
  const codes = new Set<string>();
  for (const line of content.split("\n")) {
    const col1 = line.split("\t", 1)[0] ?? "";
    if (!/#\d+=/.test(col1)) continue; // ignora cabeçalho/licença e linhas-resumo (prefixo "#")
    const dot = col1.indexOf(".");
    if (dot > 0) codes.add(col1.slice(0, dot));
  }
  return codes;
}

describe.skipIf(!hasAllFiles)("vocabulário de códigos de livro nos 6 arquivos reais", () => {
  it("todo código de livro presente mapeia via tabela USFM sem explodir", () => {
    const seen = new Set<string>();
    for (const file of STEP_FILES) {
      for (const code of bookCodesOf(readFileSync(file, "utf8"))) seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const code of seen) {
      expect(() => tvtmsBookToUsfm(code)).not.toThrow();
    }
  });
});
