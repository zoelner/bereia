/**
 * Writer/reader determinístico do JSONL canônico (`data/canonical/`,
 * ADR-006/§3.3 do plano de fechamento da Fase 1). Uma linha JSON por
 * registro, chaves em ORDEM FIXA por schema (não a ordem de inserção do
 * objeto JS de quem chama — não garantida), terminador LF, sem
 * `JSON.stringify` com indentação (logo sem espaço à direita nas linhas).
 *
 * A ordem de chaves de cada tabela é derivada da ORDEM DE DECLARAÇÃO do
 * respectivo schema Zod do core (`Object.keys(schema.shape)` preserva
 * ordem de inserção de chaves string em JS) — fonte única, evita duplicar e
 * driftar a lista de campos entre `core` e `ingestion` (ADR-007: `ingestion`
 * depende de `core`, nunca o contrário).
 */

import {
  canonicalVerseSchema,
  edgeSchema,
  originalWordSchema,
  strongsEntrySchema,
  verseTextSchema,
} from "@bereia/core";
import type { CanonicalVerse, Edge, OriginalWord, StrongsEntry, VerseText } from "@bereia/core";
import type { ZodRawShape, ZodType } from "zod";

function keyOrderOf<Shape extends ZodRawShape>(shape: Shape): readonly (keyof Shape & string)[] {
  return Object.freeze(Object.keys(shape)) as readonly (keyof Shape & string)[];
}

export const CANONICAL_VERSE_KEYS = keyOrderOf(canonicalVerseSchema.shape);
export const VERSE_TEXT_KEYS = keyOrderOf(verseTextSchema.shape);
export const ORIGINAL_WORD_KEYS = keyOrderOf(originalWordSchema.shape);
export const STRONGS_ENTRY_KEYS = keyOrderOf(strongsEntrySchema.shape);
export const EDGE_KEYS = keyOrderOf(edgeSchema.shape);

/**
 * Serializa um único registro como linha JSON com chaves na ordem fixa
 * `keyOrder`. Explode se o registro tiver uma chave a menos ou a mais do
 * que `keyOrder` — vocabulário fechado, erro cedo (ADR-008): um campo novo
 * no schema do core sem writer atualizado não passa silenciosamente.
 */
export function serializeJsonLine<T extends Record<string, unknown>>(
  record: T,
  keyOrder: readonly (keyof T & string)[],
): string {
  const recordKeys = new Set(Object.keys(record));
  for (const key of keyOrder) {
    if (!recordKeys.has(key)) {
      throw new Error(`serializeJsonLine: chave "${String(key)}" ausente no registro`);
    }
  }
  const keyOrderSet = new Set<string>(keyOrder);
  const unexpected = [...recordKeys].filter((key) => !keyOrderSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`serializeJsonLine: chaves não previstas em keyOrder: ${unexpected.join(", ")}`);
  }

  const ordered: Record<string, unknown> = {};
  for (const key of keyOrder) ordered[key] = record[key];
  return JSON.stringify(ordered);
}

/**
 * Serializa uma lista de registros — já ordenada por quem chama, ver
 * `load/order.ts` — como conteúdo JSONL completo: uma linha por registro,
 * separadas por LF, com LF final (arquivo POSIX bem formado). Byte a byte
 * determinístico para a mesma entrada (mesmos registros, mesma ordem).
 */
export function writeJsonl<T extends Record<string, unknown>>(
  records: readonly T[],
  keyOrder: readonly (keyof T & string)[],
): string {
  if (records.length === 0) return "";
  return records.map((record) => serializeJsonLine(record, keyOrder)).join("\n") + "\n";
}

/**
 * Lê um conteúdo JSONL de volta, validando cada linha contra `schema` —
 * usado no teste round-trip deste nó e pelos nós de load a jusante (N8+).
 * Explode em conteúdo malformado (JSON inválido, linha vazia, ausência de
 * LF final) ou em linha que não casa `schema`.
 */
export function readJsonl<T>(content: string, schema: ZodType<T>): T[] {
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new Error("readJsonl: conteúdo não termina com LF (formato JSONL inválido)");
  }
  const lines = content.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    if (line.length === 0) {
      throw new Error(`readJsonl: linha ${index + 1} vazia`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`readJsonl: linha ${index + 1} não é JSON válido: ${(error as Error).message}`);
    }
    return schema.parse(parsed);
  });
}

// --- Writers/readers concretos por tabela (plano §3.3, layout OQ-1) -------

export function writeCanonicalVerses(records: readonly CanonicalVerse[]): string {
  return writeJsonl(records, CANONICAL_VERSE_KEYS);
}
export function readCanonicalVerses(content: string): CanonicalVerse[] {
  return readJsonl(content, canonicalVerseSchema);
}

export function writeVerseTexts(records: readonly VerseText[]): string {
  return writeJsonl(records, VERSE_TEXT_KEYS);
}
export function readVerseTexts(content: string): VerseText[] {
  return readJsonl(content, verseTextSchema);
}

export function writeOriginalWords(records: readonly OriginalWord[]): string {
  return writeJsonl(records, ORIGINAL_WORD_KEYS);
}
export function readOriginalWords(content: string): OriginalWord[] {
  return readJsonl(content, originalWordSchema);
}

export function writeStrongsEntries(records: readonly StrongsEntry[]): string {
  return writeJsonl(records, STRONGS_ENTRY_KEYS);
}
export function readStrongsEntries(content: string): StrongsEntry[] {
  return readJsonl(content, strongsEntrySchema);
}

export function writeEdges(records: readonly Edge[]): string {
  return writeJsonl(records, EDGE_KEYS);
}
export function readEdges(content: string): Edge[] {
  return readJsonl(content, edgeSchema);
}
