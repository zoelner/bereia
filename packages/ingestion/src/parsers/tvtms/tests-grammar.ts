import { parseSingleRef, type TvtmsRef } from "./refs.js";

/**
 * Gramática da coluna Tests do TVTMS (ADR-002).
 *
 * Os testes são condições sobre o CONTEÚDO da Bíblia-fonte — é por eles que o
 * mapeador descobre qual tradição de versificação um trecho segue. Formas
 * observadas no dado real (docs/spike-tvtms.md):
 *   Ref=Exist | Ref=NotExist | Ref=Last
 *   Psa.N:TextBeforeV1=Exist|NotExist          (título de Salmo antes do v.1)
 *   ExprA < ExprB | ExprA > ExprB              (contagem de palavras)
 *   Expr := Ref['*'N] ('+' Ref['*'N])*
 * Átomos unidos por '&'; sujeiras reais toleradas: '&' duplicado, espaços,
 * refs sem livro (herdam o livro da linha), refs a livros deuterocanônicos.
 */
export type TestPredicate =
  | { kind: "exist"; ref: TvtmsRef; expected: boolean }
  | { kind: "last"; ref: TvtmsRef }
  | { kind: "textBeforeV1"; book: string; chapter: number | string; expected: boolean }
  | { kind: "compare"; op: "<" | ">"; left: WeightedTerm[]; right: WeightedTerm[] };

export interface WeightedTerm {
  ref: TvtmsRef;
  factor: number;
}

/**
 * O que o avaliador precisa saber sobre a Bíblia-fonte já parseada.
 * Livros/versos ausentes na fonte: exists=false, wordCount=0, isLast=false.
 */
export interface SourceInventory {
  exists(ref: TvtmsRef): boolean;
  /** True se ref é o último verso do seu capítulo na fonte. */
  isLast(ref: TvtmsRef): boolean;
  wordCount(ref: TvtmsRef): number;
  /** True se há texto canônico (título de Salmo) antes do v.1 do capítulo. */
  hasTextBeforeV1(book: string, chapter: number | string): boolean;
}

const TEXT_BEFORE_RE = /^(.+):TextBeforeV([0-9]+)$/;
const PREDICATE_RE = /^(.+?)=(Exist|NotExist|Last)$/;

class TestParseError extends Error {
  constructor(raw: string, detail: string) {
    super(`teste TVTMS inválido "${raw}": ${detail}`);
    this.name = "TestParseError";
  }
}

function parseWeightedSide(side: string, contextBook: string, raw: string): WeightedTerm[] {
  return side.split("+").map((termRaw) => {
    const term = termRaw.trim();
    const starIdx = term.indexOf("*");
    if (starIdx === -1) return { ref: parseSingleRef(term, contextBook), factor: 1 };
    const factor = Number(term.slice(starIdx + 1));
    if (!Number.isInteger(factor) || factor <= 0) {
      throw new TestParseError(raw, `fator inválido em "${term}"`);
    }
    return { ref: parseSingleRef(term.slice(0, starIdx), contextBook), factor };
  });
}

/** Parseia a coluna Tests de uma linha. String vazia = sempre aplicável ([]). */
export function parseTests(raw: string, contextBook: string): TestPredicate[] {
  const predicates: TestPredicate[] = [];
  for (const atomRaw of raw.split("&")) {
    const atom = atomRaw.trim();
    if (atom === "") continue; // '&' duplicado no dado

    const predicate = PREDICATE_RE.exec(atom);
    if (predicate) {
      const [, lhsRaw, keyword] = predicate;
      const lhs = (lhsRaw as string).trim();
      const textBefore = TEXT_BEFORE_RE.exec(lhs);
      if (textBefore) {
        const [, chapterRef, verseNum] = textBefore;
        if (verseNum !== "1" || keyword === "Last") {
          throw new TestParseError(atom, "só TextBeforeV1 com Exist/NotExist é conhecido");
        }
        const anchor = parseSingleRef(`${chapterRef as string}:1`, contextBook);
        predicates.push({
          kind: "textBeforeV1",
          book: anchor.book,
          chapter: anchor.chapter,
          expected: keyword === "Exist",
        });
        continue;
      }
      const ref = parseSingleRef(lhs, contextBook);
      predicates.push(
        keyword === "Last"
          ? { kind: "last", ref }
          : { kind: "exist", ref, expected: keyword === "Exist" },
      );
      continue;
    }

    const opIdx = atom.search(/[<>]/);
    if (opIdx === -1) throw new TestParseError(atom, "não é predicado nem comparação");
    const op = atom[opIdx] as "<" | ">";
    predicates.push({
      kind: "compare",
      op,
      left: parseWeightedSide(atom.slice(0, opIdx), contextBook, atom),
      right: parseWeightedSide(atom.slice(opIdx + 1), contextBook, atom),
    });
  }
  return predicates;
}

function sumWords(terms: WeightedTerm[], inv: SourceInventory): number {
  return terms.reduce((acc, t) => acc + t.factor * inv.wordCount(t.ref), 0);
}

/** Conjunção: todos os predicados verdadeiros (lista vazia = true). */
export function evaluateTests(predicates: TestPredicate[], inv: SourceInventory): boolean {
  return predicates.every((p) => {
    switch (p.kind) {
      case "exist":
        return inv.exists(p.ref) === p.expected;
      case "last":
        return inv.isLast(p.ref);
      case "textBeforeV1":
        return inv.hasTextBeforeV1(p.book, p.chapter) === p.expected;
      case "compare": {
        const left = sumWords(p.left, inv);
        const right = sumWords(p.right, inv);
        return p.op === "<" ? left < right : left > right;
      }
    }
  });
}
