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
 *
 * Campos array cuja semântica é CONJUNTO (`VerseText.thematicTags`,
 * `VerseText.authorizedLevels`) são canonicalizados (ordem ordinal fixa)
 * pelo writer antes de gravar — ver `sortedArrayCopy`/`writeVerseTexts` —
 * para não depender da ordem de inserção de quem produz o registro.
 */

import {
  canonicalVerseSchema,
  edgeSchema,
  originalWordSchema,
  strongsEntrySchema,
  verseTextSchema,
} from "@bereia/core";
import { readFileSync } from "node:fs";
import type { CanonicalVerse, Edge, OriginalWord, StrongsEntry, VerseText } from "@bereia/core";
import type { ZodRawShape, ZodType } from "zod";
import { compareOrdinal } from "./order.js";

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

/**
 * Lê um ARQUIVO JSONL validando cada linha contra `schema` — mesma semântica
 * de `readJsonl`, mas materializando UMA linha por vez a partir do Buffer
 * (fora do heap do V8). Obrigatório para derivados grandes: o arquivo de
 * embeddings real tem ~1,9GB, acima do limite de string única do V8 (~536MB)
 * — causa raiz de um OOM real; ver `load/embed.ts` (gravação em streaming).
 */
export function readJsonlFile<T>(filePath: string, schema: ZodType<T>): T[] {
  const buf = readFileSync(filePath);
  if (buf.length === 0) return [];
  if (buf[buf.length - 1] !== 0x0a) {
    throw new Error(`readJsonlFile: ${filePath} não termina com LF (formato JSONL inválido)`);
  }
  const rows: T[] = [];
  let start = 0;
  let lineNo = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    lineNo++;
    const line = buf.toString("utf8", start, end);
    if (line.length === 0) {
      throw new Error(`readJsonlFile: linha ${lineNo} vazia (${filePath})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `readJsonlFile: linha ${lineNo} não é JSON válido (${filePath}): ${(error as Error).message}`,
      );
    }
    rows.push(schema.parse(parsed));
    start = end + 1;
  }
  return rows;
}

// --- Writers/readers concretos por tabela (plano §3.3, layout OQ-1) -------

/**
 * Valida VALORES de cada registro contra o schema Zod antes de gravar — o
 * JSONL é a FONTE DE VERDADE (CLAUDE.md §2): nenhum valor inválido pode
 * alcançá-la, mesmo vindo de um builder tipado (o tipo estático não prova o
 * runtime; Zod em toda fronteira, §7). A checagem de CHAVES continua no
 * `serializeJsonLine` (vocabulário fechado).
 */
function validateAll<T>(records: readonly T[], schema: ZodType<T>, table: string): void {
  records.forEach((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) {
      throw new Error(
        `write ${table}: registro ${index} inválido para gravação na fonte de verdade — ${result.error.message}`,
      );
    }
  });
}

export function writeCanonicalVerses(records: readonly CanonicalVerse[]): string {
  validateAll(records, canonicalVerseSchema, "canonical_verses");
  return writeJsonl(records, CANONICAL_VERSE_KEYS);
}
export function readCanonicalVerses(content: string): CanonicalVerse[] {
  return readJsonl(content, canonicalVerseSchema);
}

/**
 * Ordena uma cópia de `items` ordinalmente — usado para canonicalizar
 * campos de `VerseText` cujo tipo é array mas cuja SEMÂNTICA é conjunto
 * (`thematicTags`, `authorizedLevels`): a ordem de inserção não carrega
 * significado, então fixá-la aqui (em vez de exigir que todo produtor
 * upstream — N5, curadoria — já entregue ordenado) fecha um contrato
 * implícito e garante determinismo byte a byte do JSONL mesmo se a ordem
 * de entrada variar.
 */
function sortedArrayCopy<T extends string>(items: readonly T[]): T[] {
  return [...items].sort(compareOrdinal);
}

export function writeVerseTexts(records: readonly VerseText[]): string {
  const canonicalized = records.map((record) => ({
    ...record,
    thematicTags: sortedArrayCopy(record.thematicTags),
    authorizedLevels: sortedArrayCopy(record.authorizedLevels),
  }));
  validateAll(canonicalized, verseTextSchema, "verse_texts");
  return writeJsonl(canonicalized, VERSE_TEXT_KEYS);
}
export function readVerseTexts(content: string): VerseText[] {
  return readJsonl(content, verseTextSchema);
}

export function writeOriginalWords(records: readonly OriginalWord[]): string {
  validateAll(records, originalWordSchema, "original_words");
  return writeJsonl(records, ORIGINAL_WORD_KEYS);
}
export function readOriginalWords(content: string): OriginalWord[] {
  return readJsonl(content, originalWordSchema);
}

export function writeStrongsEntries(records: readonly StrongsEntry[]): string {
  validateAll(records, strongsEntrySchema, "strongs");
  return writeJsonl(records, STRONGS_ENTRY_KEYS);
}
export function readStrongsEntries(content: string): StrongsEntry[] {
  return readJsonl(content, strongsEntrySchema);
}

export function writeEdges(records: readonly Edge[]): string {
  validateAll(records, edgeSchema, "edges");
  return writeJsonl(records, EDGE_KEYS);
}
export function readEdges(content: string): Edge[] {
  return readJsonl(content, edgeSchema);
}
