import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTagntRef, parseTahotRef, stepCanonicalRef } from "./refs.js";
import { tvtmsBookToUsfm } from "../tvtms/books.js";

/**
 * Testes ancorados em requisito (ADR-008): a notação da col 1 do STEPBible é contrato
 * externo. Casos baseados no vocabulário REAL das 6 fontes pinadas (strings estruturais —
 * códigos de ref e carimbos, não conteúdo teológico) + casos de explosão. O bloco de
 * integração no fim percorre TODA col 1 real pelos parsers e é a prova de que o vocabulário
 * fechado bate com o dado (não pode ficar em skip no aceite: rode com DATA_DIR do repo).
 */

const FIRM = { variant: false, bracketed: false };

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
      textType: { raw: "L", base: "L", marker: null },
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
    expect(parseTahotRef("Jol.3.1(4.1)#01=L").hebrew).toEqual({ chapter: 4, verse: 1 });
  });

  it("TextType real = base fechada + marcador cru; Ketiv/Qere carregados com carimbo (Q4)", () => {
    // Q(K)/Q(k): Qere com o Ketiv carimbado no marcador — precisam parsear, não explodir.
    expect(parseTahotRef("Gen.1.1#01=Q(K)").textType).toEqual({ raw: "Q(K)", base: "Q", marker: "K" });
    expect(parseTahotRef("Gen.1.1#01=Q(k)").textType).toEqual({ raw: "Q(k)", base: "Q", marker: "k" });
    // Combinações de testemunhos na base + marcador de letras/soma.
    expect(parseTahotRef("Gen.1.1#01=L(abh)").textType).toEqual({ raw: "L(abh)", base: "L", marker: "abh" });
    expect(parseTahotRef("Gen.1.1#01=LA(bh)").textType).toEqual({ raw: "LA(bh)", base: "LA", marker: "bh" });
    expect(parseTahotRef("Gen.1.1#01=LBH(a+C)").textType).toEqual({ raw: "LBH(a+C)", base: "LBH", marker: "a+C" });
    // Bases sem marcador.
    expect(parseTahotRef("Gen.1.1#01=X").textType).toEqual({ raw: "X", base: "X", marker: null });
    expect(parseTahotRef("Gen.1.1#01=R").textType).toMatchObject({ base: "R", marker: null });
  });

  it("livro deuterocanônico conhecido sinaliza skip (book=null), não explode", () => {
    expect(parseTahotRef("Sir.1.1#01=L").book).toBeNull();
  });

  it("posição multi-dígito preserva o valor (Psa.119.176#10=L)", () => {
    expect(parseTahotRef("Psa.119.176#10=L")).toMatchObject({ chapter: 119, verse: 176, position: 10 });
  });

  it("EXPLODE em base de TextType fora do vocabulário (Gen.1.1#01=Z)", () => {
    expect(() => parseTahotRef("Gen.1.1#01=Z")).toThrow(/base de TextType desconhecida/);
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
      wordType: { raw: "NKO", na: FIRM, tr: FIRM, other: FIRM },
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
      wordType: { raw: "K", na: null, tr: FIRM, other: null },
    });
  });

  it("colchete [KJV] com numeração menor (3Jn.1.15[1.14]#05=NKO)", () => {
    expect(parseTagntRef("3Jn.1.15[1.14]#05=NKO").kjv).toEqual({ chapter: 1, verse: 14 });
  });

  it("verso só-TR ausente no NA (Rom.16.24#01=KO)", () => {
    expect(parseTagntRef("Rom.16.24#01=KO").wordType).toEqual({
      raw: "KO",
      na: null,
      tr: FIRM,
      other: FIRM,
    });
  });

  it("bracketed distingue caso (Finding 3): N(K)O ≠ N(k)O só no eixo variant", () => {
    expect(parseTagntRef("Jhn.1.1#01=N(K)O").wordType).toEqual({
      raw: "N(K)O",
      na: FIRM,
      tr: { variant: false, bracketed: true },
      other: FIRM,
    });
    expect(parseTagntRef("Jhn.1.1#01=N(k)O").wordType).toEqual({
      raw: "N(k)O",
      na: FIRM,
      tr: { variant: true, bracketed: true },
      other: FIRM,
    });
  });

  it("bracketed no outro grego preserva o case (NK(o) vs NK(O))", () => {
    expect(parseTagntRef("Jhn.1.1#02=NK(o)").wordType.other).toEqual({ variant: true, bracketed: true });
    expect(parseTagntRef("Jhn.1.1#02=NK(O)").wordType.other).toEqual({ variant: false, bracketed: true });
  });

  it("letras minúsculas são variantes não-bracketed (no → na/other variant)", () => {
    expect(parseTagntRef("Jhn.1.1#03=no").wordType).toEqual({
      raw: "no",
      na: { variant: true, bracketed: false },
      tr: null,
      other: { variant: true, bracketed: false },
    });
  });

  it("parêntese logo no início (Act.8.37[8.37]... estilo (k)O)", () => {
    expect(parseTagntRef("Jhn.1.1#04=(k)O").wordType).toEqual({
      raw: "(k)O",
      na: null,
      tr: { variant: true, bracketed: true },
      other: FIRM,
    });
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
 * ausentes, nunca verde falso; rode com DATA_DIR apontando ao repo principal). Prova de
 * verdade do vocabulário fechado: percorre TODA col 1 distinta de linha-por-palavra
 * (padrão "#\d+=") dos 6 arquivos pelo parser correspondente e afirma que NENHUMA explode.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", rel);
const TAHOT_FILES = [
  "stepbible-tahot/TAHOT_Gen-Deu.txt",
  "stepbible-tahot/TAHOT_Jos-Est.txt",
  "stepbible-tahot/TAHOT_Job-Sng.txt",
  "stepbible-tahot/TAHOT_Isa-Mal.txt",
].map(src);
const TAGNT_FILES = [
  "stepbible-tagnt/TAGNT_Mat-Jhn.txt",
  "stepbible-tagnt/TAGNT_Act-Rev.txt",
].map(src);
const hasAllFiles = [...TAHOT_FILES, ...TAGNT_FILES].every((f) => existsSync(f));

/** Col 1 distintas de linha-por-palavra (têm "#Pos="); ignora cabeçalho/licença e linhas-resumo "#". */
function distinctWordCol1(files: readonly string[]): Set<string> {
  const col1s = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const col1 = line.split("\t", 1)[0] ?? "";
      if (/#\d+=/.test(col1)) col1s.add(col1);
    }
  }
  return col1s;
}

/** Aplica `parse` a cada col 1 e devolve os primeiros erros (col1 + mensagem) — 0 = tudo parseou. */
function collectFailures(col1s: Iterable<string>, parse: (c: string) => unknown): string[] {
  const failures: string[] = [];
  for (const col1 of col1s) {
    try {
      parse(col1);
    } catch (err) {
      if (failures.length < 20) failures.push(`${col1} :: ${(err as Error).message}`);
    }
  }
  return failures;
}

describe.skipIf(!hasAllFiles)("col 1 real percorrida pelos parsers (6 arquivos pinados)", () => {
  it("parseTahotRef não explode em nenhuma col 1 real do TAHOT", () => {
    const col1s = distinctWordCol1(TAHOT_FILES);
    expect(col1s.size).toBeGreaterThan(100_000);
    expect(collectFailures(col1s, parseTahotRef)).toEqual([]);
  });

  it("parseTagntRef não explode em nenhuma col 1 real do TAGNT", () => {
    const col1s = distinctWordCol1(TAGNT_FILES);
    expect(col1s.size).toBeGreaterThan(10_000);
    expect(collectFailures(col1s, parseTagntRef)).toEqual([]);
  });

  it("todo código de livro real mapeia via tabela USFM (canônico ou deuterocanônico)", () => {
    const codes = new Set<string>();
    for (const col1 of distinctWordCol1([...TAHOT_FILES, ...TAGNT_FILES])) {
      const dot = col1.indexOf(".");
      if (dot > 0) codes.add(col1.slice(0, dot));
    }
    expect(collectFailures(codes, tvtmsBookToUsfm)).toEqual([]);
  });
});
