import { USFM_BOOKS } from "@bereia/core";
import type { MappedRef, SourceRef, VersificationMapper } from "./contract.js";
import { tvtmsBookToUsfm, USFM_TO_TVTMS } from "./books.js";
import type { RefItem, TvtmsRef } from "./refs.js";
import { evaluateTests, type SourceInventory } from "./tests-grammar.js";
import type { TvtmsRule } from "./expanded.js";

/**
 * Mapper de versificação: tradição da fonte → versificação-mestre (KJV).
 *
 * Semântica (ADR-002 + docs/spike-tvtms.md):
 * - As regras cujos Tests passam contra o CONTEÚDO da fonte estão "ativas" —
 *   é assim que o TVTMS seleciona a tradição efetiva, trecho a trecho.
 * - Verso sem regra ativa mapeia para si mesmo (o TVTMS só lista diferenças).
 * - Se tradições ativas divergem no resultado, `ref.tradition` desempata;
 *   ambiguidade restante EXPLODE — mapeamento não-determinístico é bug.
 * - Título de Salmo (Standard "Title") vira verse 0 no MappedRef.
 */

/** Contagem de versos da versificação-mestre — expande ranges entre capítulos. */
export interface StandardInventory {
  lastVerse(book: string, chapter: number): number;
}

const BOOK_ORDER = new Map(USFM_BOOKS.map((b, i) => [b as string, i]));

function mappedKey(ref: MappedRef): string {
  return `${ref.book}_${ref.chapter}_${ref.verse}`;
}

function toMappedRef(ref: TvtmsRef, line: number): MappedRef {
  const book = tvtmsBookToUsfm(ref.book);
  if (book === null) {
    throw new Error(`TVTMS linha ${line}: StandardRef aponta para livro fora do cânon (${ref.book})`);
  }
  if (typeof ref.chapter !== "number") {
    throw new Error(`TVTMS linha ${line}: capítulo-letra em StandardRef canônico (${ref.book}.${ref.chapter})`);
  }
  return {
    book,
    chapter: ref.chapter,
    verse: ref.verse === "Title" ? 0 : ref.verse,
    subverse: ref.subverse,
  };
}

function expandStandardItem(item: RefItem, line: number, std: StandardInventory): MappedRef[] {
  if (item.kind === "raw") {
    throw new Error(`TVTMS linha ${line}: StandardRef inparseável em regra canônica ("${item.text}")`);
  }
  if (item.kind === "single") return [toMappedRef(item.ref, line)];

  const start = toMappedRef(item.start, line);
  const end = toMappedRef(item.end, line);
  if (start.book !== end.book) {
    throw new Error(`TVTMS linha ${line}: range entre livros distintos`);
  }
  const result: MappedRef[] = [];
  for (let ch = start.chapter; ch <= end.chapter; ch++) {
    const first = ch === start.chapter ? start.verse : 1;
    const last = ch === end.chapter ? end.verse : std.lastVerse(start.book, ch);
    for (let v = first; v <= last; v++) {
      result.push({ book: start.book, chapter: ch, verse: v, subverse: null });
    }
  }
  if (result.length === 0) {
    throw new Error(`TVTMS linha ${line}: range vazio em StandardRef`);
  }
  return result;
}

/** União de refs, preferindo subverse=null quando o mesmo verso aparece 2x. */
function dedupe(refs: MappedRef[]): MappedRef[] {
  const byKey = new Map<string, MappedRef>();
  for (const ref of refs) {
    const key = mappedKey(ref);
    const existing = byKey.get(key);
    if (existing === undefined || (existing.subverse !== null && ref.subverse === null)) {
      byKey.set(key, ref);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (BOOK_ORDER.get(a.book) ?? 0) - (BOOK_ORDER.get(b.book) ?? 0) ||
      a.chapter - b.chapter ||
      a.verse - b.verse,
  );
}

function itemMatches(item: RefItem, book: string, chapter: number, verse: number): boolean {
  if (item.kind === "raw") return false;
  if (item.kind === "single") {
    const r = item.ref;
    return r.book === book && r.chapter === chapter && r.verse === verse;
  }
  const { start, end } = item;
  if (start.book !== book || start.verse === "Title" || end.verse === "Title") return false;
  if (typeof start.chapter !== "number" || typeof end.chapter !== "number") return false;
  if (chapter < start.chapter || chapter > end.chapter) return false;
  if (chapter === start.chapter && verse < start.verse) return false;
  if (chapter === end.chapter && verse > end.verse) return false;
  return true;
}

function ruleMatches(rule: TvtmsRule, book: string, chapter: number, verse: number): boolean {
  return rule.source.some((item) => itemMatches(item, book, chapter, verse));
}

/** Rótulos de tradição do upstream são compostos ("Eng-KJV+Hebrew+Latin"). */
function sourceTypeIncludes(sourceType: string, tradition: string): boolean {
  return sourceType.split("+").some((part) => part.trim() === tradition);
}

export class AmbiguousMappingError extends Error {
  constructor(ref: SourceRef, lines: number[]) {
    super(
      `mapeamento ambíguo para ${ref.book} ${ref.chapter}:${ref.verse} ` +
        `(tradição "${ref.tradition}"): tradições ativas divergem — linhas TVTMS ${lines.join(", ")}. ` +
        "Determinismo é requisito: resolva a tradição da fonte antes de ingerir.",
    );
    this.name = "AmbiguousMappingError";
  }
}

export class TvtmsMapper implements VersificationMapper {
  private readonly byBook = new Map<string, TvtmsRule[]>();
  private readonly activeCache = new Map<TvtmsRule, boolean>();

  constructor(
    rules: TvtmsRule[],
    private readonly sourceInv: SourceInventory,
    private readonly standardInv: StandardInventory,
  ) {
    for (const rule of rules) {
      const books = new Set(
        rule.source.flatMap((item) =>
          item.kind === "raw" ? [] : [item.kind === "single" ? item.ref.book : item.start.book],
        ),
      );
      for (const book of books) {
        const list = this.byBook.get(book) ?? [];
        list.push(rule);
        this.byBook.set(book, list);
      }
    }
  }

  private isActive(rule: TvtmsRule): boolean {
    let active = this.activeCache.get(rule);
    if (active === undefined) {
      active = evaluateTests(rule.tests, this.sourceInv);
      this.activeCache.set(rule, active);
    }
    return active;
  }

  toKjv(ref: SourceRef): MappedRef[] {
    const tvtmsBook = USFM_TO_TVTMS[ref.book];
    if (tvtmsBook === undefined) {
      throw new Error(`livro sem correspondência TVTMS: ${ref.book}`);
    }

    const active = (this.byBook.get(tvtmsBook) ?? []).filter(
      (rule) => ruleMatches(rule, tvtmsBook, ref.chapter, ref.verse) && this.isActive(rule),
    );
    if (active.length === 0) {
      return [{ book: ref.book, chapter: ref.chapter, verse: ref.verse, subverse: null }];
    }

    // Dentro de um sourceType, as linhas (verso inteiro + partes !a/!b) somam-se;
    // entre sourceTypes, os resultados precisam coincidir — ou o desempate decide.
    const byType = new Map<string, { lines: number[]; refs: MappedRef[] }>();
    for (const rule of active) {
      const entry = byType.get(rule.sourceType) ?? { lines: [], refs: [] };
      entry.lines.push(rule.line);
      entry.refs.push(...rule.standard.flatMap((item) => expandStandardItem(item, rule.line, this.standardInv)));
      byType.set(rule.sourceType, entry);
    }

    const outcomes = [...byType.entries()].map(([sourceType, entry]) => ({
      sourceType,
      lines: entry.lines,
      refs: dedupe(entry.refs),
      signature: dedupe(entry.refs).map(mappedKey).join(";"),
    }));

    const signatures = new Set(outcomes.map((o) => o.signature));
    if (signatures.size === 1) return (outcomes[0] as (typeof outcomes)[number]).refs;

    const preferred = outcomes.filter((o) => sourceTypeIncludes(o.sourceType, ref.tradition));
    const preferredSignatures = new Set(preferred.map((o) => o.signature));
    if (preferredSignatures.size === 1 && preferred[0] !== undefined) return preferred[0].refs;

    throw new AmbiguousMappingError(ref, outcomes.flatMap((o) => o.lines));
  }
}
