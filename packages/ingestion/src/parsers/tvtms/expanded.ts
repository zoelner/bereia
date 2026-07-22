import { z } from "zod";
import { parseRefList, refItemIsCanonical, type RefItem } from "./refs.js";
import { parseTests, type TestPredicate } from "./tests-grammar.js";

/**
 * Parser da seção #DataStart(Expanded) do TVTMS — o TSV que a Fase 1 consome.
 * Vocabulário de ações FECHADO: valor novo no upstream deve explodir aqui,
 * nunca passar despercebido (determinismo é requisito de produto).
 */
export const TVTMS_ACTIONS = [
  "Keep verse",
  "Renumber verse",
  "Renumber title",
  "Concatenation",
  "DividedPrev verse",
  "DividedNext verse",
  "MergedPrev verse",
  "MergedNext verse",
  "IfEmpty verse",
  "Psalm title",
  "CopiedFrom verse",
  "MovedFrom verse",
] as const;

export const tvtmsActionSchema = z.enum(TVTMS_ACTIONS);
export type TvtmsAction = z.infer<typeof tvtmsActionSchema>;

export interface TvtmsRule {
  /** Linha 1-based no arquivo original — rastreabilidade de erro. */
  line: number;
  /** Rótulo de tradição do upstream ("Hebrew", "Eng-KJV+Latin", …), trim aplicado. */
  sourceType: string;
  /**
   * Referências-fonte. Quase sempre 1 item (único ou range "3Jn.1:14-15");
   * listas ocorrem em 7 Concatenations do dado real ("Rev.12:18; 13:1").
   */
  source: RefItem[];
  standard: RefItem[];
  action: TvtmsAction;
  /** Variante marcada com '*' no upstream (casos raros/incertos). */
  starred: boolean;
  /** Condições sobre o conteúdo da fonte; [] = sempre aplicável. */
  tests: TestPredicate[];
}

export interface ExpandedParseResult {
  rules: TvtmsRule[];
  /** Linhas deuterocanônicas puladas — contadas, nunca silenciadas. */
  skipped: { line: number; sourceRef: string; reason: string }[];
}

const DATA_START = "#DataStart(Expanded)";
const DATA_END = "#DataEnd(Expanded)";

export function parseTvtmsExpanded(fileText: string): ExpandedParseResult {
  const lines = fileText.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(DATA_START));
  const endIdx = lines.findIndex((l) => l.startsWith(DATA_END));
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`seção ${DATA_START}…${DATA_END} não encontrada no TVTMS`);
  }

  const rules: TvtmsRule[] = [];
  const skipped: ExpandedParseResult["skipped"] = [];

  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    const cells = line.split("\t");
    const sourceType = (cells[0] ?? "").trim();
    const sourceRefRaw = (cells[1] ?? "").trim();

    // Cabeçalho, separadores ('===), comentários (#) e linhas vazias.
    if (sourceRefRaw === "" || sourceType.startsWith("#") || sourceType.startsWith("'")) {
      continue;
    }
    if (sourceType === "SourceType") continue;

    const lineNo = i + 1;
    const standardRefRaw = (cells[2] ?? "").trim();
    const actionRaw = (cells[3] ?? "").trim();
    const testsRaw = (cells[8] ?? "").trim();

    const starred = actionRaw.endsWith("*");
    const actionParsed = tvtmsActionSchema.safeParse(
      starred ? actionRaw.slice(0, -1).trim() : actionRaw,
    );
    if (!actionParsed.success) {
      throw new Error(`TVTMS linha ${lineNo}: ação desconhecida "${actionRaw}"`);
    }

    let source: RefItem[];
    try {
      source = parseRefList(sourceRefRaw);
    } catch (err) {
      throw new Error(`TVTMS linha ${lineNo}: ${(err as Error).message}`);
    }

    if (!source.every(refItemIsCanonical)) {
      skipped.push({
        line: lineNo,
        sourceRef: sourceRefRaw,
        reason: "livro fora do cânon de 66 (deuterocanônico)",
      });
      continue;
    }
    const firstItem = source[0] as Exclude<RefItem, { kind: "raw" }>;
    const contextBook = firstItem.kind === "single" ? firstItem.ref.book : firstItem.start.book;

    try {
      rules.push({
        line: lineNo,
        sourceType,
        source,
        standard: parseRefList(standardRefRaw, contextBook),
        action: actionParsed.data,
        starred,
        tests: parseTests(testsRaw, contextBook),
      });
    } catch (err) {
      throw new Error(`TVTMS linha ${lineNo}: ${(err as Error).message}`);
    }
  }

  if (rules.length === 0) throw new Error("seção Expanded sem regras — arquivo corrompido?");
  return { rules, skipped };
}
