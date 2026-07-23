#!/usr/bin/env node
/**
 * Load Postgres (N10, plano de fechamento da Fase 1 §3.5). Lê o JSONL
 * canônico (`data/canonical/`, FONTE DE VERDADE, CLAUDE.md §4) e,
 * opcionalmente, o derivado de embeddings (`data/derived/embeddings-{revision}
 * .jsonl`, N9), e projeta nas 5 tabelas relacionais na ordem de FK:
 * `canonical_verses` → `verse_texts` (embedding joinado por `canonicalId`+
 * `translation`) → `strongs` → `original_words` → `edges`.
 *
 * ## Projeção descartável, load idempotente (CLAUDE.md §2)
 * O Postgres é uma projeção reconstruível a qualquer momento a partir do
 * JSONL — nunca a fonte de verdade. Por isso o load inteiro roda dentro de
 * UMA transação: apaga o conteúdo das 5 tabelas (via `DELETE`, respeitando a
 * ordem inversa de FK — `TRUNCATE` explodiria por causa das FKs de
 * `curation_log`/`reports`/`interpretations` para `canonical_verses`, tabelas
 * fora do escopo deste nó que não devem ser tocadas) e regrava a partir do
 * JSONL. Duas execuções seguidas com a mesma entrada convergem para o mesmo
 * estado (mesmas contagens, mesma amostra determinística via `ORDER BY id`).
 *
 * ## Migrations existentes, aplicadas de forma idempotente
 * Não há `drizzle-kit` configurado no repo (nenhum `drizzle.config.ts`) — a
 * convenção adotada aqui é aplicar os `.sql` de `packages/core/drizzle/`
 * diretamente, cada um guardado por uma checagem de existência do artefato
 * que cria (`canonical_verses` para `0000_init.sql`, a coluna
 * `original_words.edition` para `0001_original_words_edition.sql`) — uma
 * segunda execução não tenta recriar o que já existe. Este módulo NÃO gera
 * migration nova nem edita as existentes (fora do escopo do N10).
 *
 * ## Hard filter (CLAUDE.md §5)
 * `canon_status`, `authorized_levels`, `human_reviewed` etc. chegam ao banco
 * exatamente como gravados no JSONL — são os metadados que o retrieval
 * aplica ANTES do ranking vetorial; nenhuma transformação acontece aqui além
 * da re-validação Zod na leitura.
 *
 * ## Cross-check de integridade referencial
 * `verse_texts.canonicalId`, `edges.sourceId/targetId` e `original_words.
 * canonicalId` são checados contra o conjunto de `canonical_verses` ANTES de
 * qualquer insert (além da FK real que o Postgres também aplica nessas três
 * colunas). `original_words.strongId` → `strongs.id` NÃO é uma FK real no
 * schema do core (`db/schema.ts` não declara `.references()` nesse campo,
 * ver notas de retorno do nó) — por isso a checagem aqui é a ÚNICA garantia
 * dessa relação; qualquer violação explode com mensagem clara em PT.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import type { CanonicalVerse, Edge, OriginalWord, StrongsEntry, VerseText } from "@bereia/core";
import {
  readCanonicalVerses,
  readEdges,
  readJsonl,
  readOriginalWords,
  readStrongsEntries,
  readVerseTexts,
} from "./jsonl.js";
import { EXPECTED_EMBEDDING_MODEL_STAMP, EXPECTED_HF_REVISION, embeddingRowSchema, type EmbeddingRow } from "./embed.js";

// --- leitura do JSONL canônico (re-validada por Zod, ver load/jsonl.ts) -----

export interface CanonicalData {
  canonicalVerses: CanonicalVerse[];
  verseTexts: VerseText[];
  originalWords: OriginalWord[];
  strongsEntries: StrongsEntry[];
  edges: Edge[];
}

/** Lê e reúne todos os arquivos `.jsonl` de um diretório particionado (`verse_texts/`, `original_words/`). */
function readAllPartitioned<T>(dir: string, readContent: (content: string) => T[]): T[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new Error(`load/postgres: não foi possível ler o diretório "${dir}" — ${(error as Error).message}`);
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort(); // ordem de leitura irrelevante — insert não depende de ordem
  const all: T[] = [];
  for (const file of files) {
    all.push(...readContent(readFileSync(path.join(dir, file), "utf8")));
  }
  return all;
}

function requireFile(filePath: string, hint: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`load/postgres: "${filePath}" ausente — ${hint}`);
  }
  return readFileSync(filePath, "utf8");
}

/** Lê as 5 tabelas do JSONL canônico em `canonicalDir` (layout OQ-1). */
export function readCanonicalData(canonicalDir: string): CanonicalData {
  const canonicalVerses = readCanonicalVerses(
    requireFile(
      path.join(canonicalDir, "canonical_verses.jsonl"),
      "rode build:canonical antes de load:postgres (ver docs/plano-fechamento-fase1.md §3.3)",
    ),
  );
  const verseTexts = readAllPartitioned(path.join(canonicalDir, "verse_texts"), readVerseTexts);
  const originalWords = readAllPartitioned(path.join(canonicalDir, "original_words"), readOriginalWords);
  const strongsEntries = readStrongsEntries(
    requireFile(path.join(canonicalDir, "strongs.jsonl"), "rode build:canonical antes de load:postgres"),
  );
  const edges = readEdges(
    requireFile(path.join(canonicalDir, "edges.jsonl"), "rode build:canonical antes de load:postgres"),
  );
  return { canonicalVerses, verseTexts, originalWords, strongsEntries, edges };
}

// --- cross-check de integridade referencial ---------------------------------

/**
 * Confere as relações entre tabelas do JSONL ANTES de qualquer insert — as
 * mensagens de erro aqui são específicas e em PT; a FK real do Postgres (para
 * `verse_texts`/`original_words`/`edges` → `canonical_verses`) é redundante
 * com esta checagem, mas `original_words.strongId` → `strongs.id` NÃO é FK no
 * schema do core, então esta é a única garantia dessa relação.
 */
export function crossCheckIntegrity(data: CanonicalData): void {
  const verseIds = new Set(data.canonicalVerses.map((verse) => verse.id));
  const strongIds = new Set(data.strongsEntries.map((entry) => entry.id));
  const problems: string[] = [];

  const orphanVerseTexts = data.verseTexts.filter((vt) => !verseIds.has(vt.canonicalId));
  if (orphanVerseTexts.length > 0) {
    problems.push(
      `verse_texts.canonical_id sem entrada em canonical_verses: ${String(orphanVerseTexts.length)} linha(s) — amostra: ` +
        orphanVerseTexts
          .slice(0, 5)
          .map((vt) => `${vt.canonicalId}/${vt.translation}`)
          .join(", "),
    );
  }

  const orphanOriginalWords = data.originalWords.filter((word) => !verseIds.has(word.canonicalId));
  if (orphanOriginalWords.length > 0) {
    problems.push(
      `original_words.canonical_id sem entrada em canonical_verses: ${String(orphanOriginalWords.length)} linha(s) — amostra: ` +
        orphanOriginalWords
          .slice(0, 5)
          .map((word) => `${word.canonicalId}#${String(word.position)}`)
          .join(", "),
    );
  }

  const unresolvedStrongIds = data.originalWords.filter(
    (word) => word.strongId !== null && !strongIds.has(word.strongId),
  );
  if (unresolvedStrongIds.length > 0) {
    problems.push(
      `original_words.strong_id sem entrada em strongs: ${String(unresolvedStrongIds.length)} linha(s) — amostra: ` +
        unresolvedStrongIds
          .slice(0, 5)
          .map((word) => `${word.canonicalId}#${String(word.position)}→${String(word.strongId)}`)
          .join(", "),
    );
  }

  const orphanEdges = data.edges.filter((edge) => !verseIds.has(edge.sourceId) || !verseIds.has(edge.targetId));
  if (orphanEdges.length > 0) {
    problems.push(
      `edges.source_id/target_id sem entrada em canonical_verses: ${String(orphanEdges.length)} linha(s) — amostra: ` +
        orphanEdges
          .slice(0, 5)
          .map((edge) => `${edge.sourceId}→${edge.targetId}`)
          .join(", "),
    );
  }

  if (problems.length > 0) {
    throw new Error(`load/postgres: integridade referencial quebrada no JSONL canônico:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

// --- join do derivado de embeddings (N9, opcional) --------------------------

function embeddingKey(canonicalId: string, translation: string): string {
  return `${canonicalId} ${translation}`;
}

/** Caminho default do derivado (mesma convenção do N9, `load/embed.ts#defaultOutFile`). */
export function resolveEmbeddingsFile(dataDir: string, explicitFile: string | undefined): string {
  return explicitFile ?? path.join(dataDir, "derived", `embeddings-${EXPECTED_HF_REVISION}.jsonl`);
}

/**
 * Lê e valida o derivado de embeddings quando presente. `null` = arquivo
 * ausente — `verse_texts.embedding` fica NULL no load, aviso emitido via
 * `onWarning` (o embed oficial pode rodar depois, ADR-006). Quando presente,
 * o join por `(canonicalId, translation)` é OBRIGATÓRIO e COMPLETO nos dois
 * sentidos: linha derivada órfã (sem `verse_texts` correspondente) ou
 * `embeddingModel` divergente do carimbo esperado (OQ-8) explodem; e todo
 * `verse_texts` precisa ter uma linha derivada correspondente — um derivado
 * parcial (embed batch incompleto) também explode, para nunca gravar um
 * estado ambíguo (parte com vetor, parte sem, silenciosamente).
 */
export function loadEmbeddings(
  filePath: string,
  verseTexts: readonly VerseText[],
  onWarning: (message: string) => void,
): ReadonlyMap<string, EmbeddingRow> | null {
  if (!existsSync(filePath)) {
    onWarning(
      `load/postgres: derivado de embeddings ausente em "${filePath}" — verse_texts.embedding fica NULL ` +
        "(rode embed:batch depois para popular, ADR-005/§3.4)",
    );
    return null;
  }

  const rows = readJsonl(readFileSync(filePath, "utf8"), embeddingRowSchema);

  const badModel = rows.filter((row) => row.embeddingModel !== EXPECTED_EMBEDDING_MODEL_STAMP);
  if (badModel.length > 0) {
    throw new Error(
      `load/postgres: embeddingModel divergente do carimbo esperado ("${EXPECTED_EMBEDDING_MODEL_STAMP}") em ` +
        `${String(badModel.length)} linha(s) do derivado "${filePath}" — amostra: ` +
        badModel
          .slice(0, 5)
          .map((row) => `${row.canonicalId}/${row.translation}=${row.embeddingModel}`)
          .join(", "),
    );
  }

  const verseTextKeys = new Set(verseTexts.map((vt) => embeddingKey(vt.canonicalId, vt.translation)));
  const map = new Map<string, EmbeddingRow>();
  const orphans: EmbeddingRow[] = [];
  for (const row of rows) {
    const key = embeddingKey(row.canonicalId, row.translation);
    if (!verseTextKeys.has(key)) {
      orphans.push(row);
      continue;
    }
    map.set(key, row);
  }
  if (orphans.length > 0) {
    throw new Error(
      `load/postgres: ${String(orphans.length)} linha(s) do derivado de embeddings não correspondem a nenhum ` +
        `verse_texts do JSONL canônico ("${filePath}") — amostra: ` +
        orphans
          .slice(0, 5)
          .map((row) => `${row.canonicalId}/${row.translation}`)
          .join(", "),
    );
  }

  const missing = verseTexts.filter((vt) => !map.has(embeddingKey(vt.canonicalId, vt.translation)));
  if (missing.length > 0) {
    throw new Error(
      `load/postgres: ${String(missing.length)} linha(s) de verse_texts sem embedding correspondente no derivado ` +
        `("${filePath}") — o join precisa ser completo quando o arquivo existe (derivado parcial); amostra: ` +
        missing
          .slice(0, 5)
          .map((vt) => `${vt.canonicalId}/${vt.translation}`)
          .join(", "),
    );
  }

  return map;
}

// --- formatação de valores para o driver `postgres` (postgres-js) ----------

type SqlValue = string | number | boolean | null;
type SqlRow = readonly SqlValue[];

/** Literal de texto do tipo `vector` do pgvector: `[v1,v2,...]` (sem espaço). */
function formatVector(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

/** Literal de array do Postgres (`text[]`): `{"a","b"}`, com escape de `\`/`"`. */
function formatTextArray(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

// --- insert em lote (parametrizado, com cast opcional por coluna) ----------

/**
 * Executor mínimo necessário para o insert em lote — satisfeito tanto por
 * `postgres.Sql` (conexão de topo, usado pelas migrations) quanto por
 * `postgres.TransactionSql` (dentro de `sql.begin`, usado pelos inserts).
 * Definido estruturalmente para não precisar nomear os tipos do driver.
 */
type UnsafeExec = (query: string, params: SqlValue[]) => Promise<unknown>;

/**
 * Monta e executa `INSERT INTO table (...) VALUES (...), (...), ...` em
 * lotes de `chunkSize` linhas — evita um único statement gigante para
 * tabelas grandes (`original_words` ~470k linhas). Cada coluna pode ter um
 * cast explícito (`::vector`, `::canon_status`, `::text[]`, `::edge_kind`) —
 * necessário porque os parâmetros chegam como `string | number | boolean |
 * null` e o Postgres não infere automaticamente tipos customizados/enum a
 * partir do parâmetro sem contexto de cast explícito em todos os casos.
 */
async function bulkInsert(
  exec: UnsafeExec,
  table: string,
  columns: readonly string[],
  rows: readonly SqlRow[],
  casts: Readonly<Record<string, string>>,
  chunkSize = 2000,
): Promise<void> {
  const columnList = columns.map((column) => `"${column}"`).join(", ");
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    if (chunk.length === 0) continue;
    const values: SqlValue[] = [];
    const tuples: string[] = [];
    let paramIndex = 1;
    for (const row of chunk) {
      const placeholders = columns.map((column, columnIndex) => {
        const cast = casts[column];
        const placeholder = cast !== undefined ? `$${String(paramIndex)}::${cast}` : `$${String(paramIndex)}`;
        paramIndex += 1;
        values.push(row[columnIndex] ?? null);
        return placeholder;
      });
      tuples.push(`(${placeholders.join(", ")})`);
    }
    await exec(`INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(", ")}`, values);
  }
}

// --- colunas/casts por tabela (espelha db/schema.ts do core) ---------------

const CANONICAL_VERSES_COLUMNS = ["id", "book", "chapter", "verse", "canon_status", "theological_category"] as const;
const CANONICAL_VERSES_CASTS = { canon_status: "canon_status" } as const;

const VERSE_TEXTS_COLUMNS = [
  "canonical_id",
  "translation",
  "text",
  "embedding",
  "embedding_model",
  "thematic_tags",
  "cultural_context",
  "human_reviewed",
  "reviewed_by",
  "authorized_levels",
] as const;
const VERSE_TEXTS_CASTS = { embedding: "vector", thematic_tags: "text[]", authorized_levels: "text[]" } as const;

const STRONGS_COLUMNS = ["id", "language", "lemma", "transliteration", "definition"] as const;

const ORIGINAL_WORDS_COLUMNS = [
  "canonical_id",
  "position",
  "lexeme",
  "strong_id",
  "strong_raw",
  "morphology",
  "edition",
] as const;

const EDGES_COLUMNS = ["source_id", "target_id", "kind"] as const;
const EDGES_CASTS = { kind: "edge_kind" } as const;

function canonicalVerseRow(verse: CanonicalVerse): SqlRow {
  return [verse.id, verse.book, verse.chapter, verse.verse, verse.canonStatus, verse.theologicalCategory];
}

function verseTextRow(vt: VerseText, embeddingByKey: ReadonlyMap<string, EmbeddingRow> | null): SqlRow {
  const embeddingRow = embeddingByKey?.get(embeddingKey(vt.canonicalId, vt.translation));
  return [
    vt.canonicalId,
    vt.translation,
    vt.text,
    embeddingRow !== undefined ? formatVector(embeddingRow.embedding) : null,
    embeddingRow?.embeddingModel ?? vt.embeddingModel,
    formatTextArray(vt.thematicTags),
    vt.culturalContext,
    vt.humanReviewed,
    vt.reviewedBy,
    formatTextArray(vt.authorizedLevels),
  ];
}

function strongsRow(entry: StrongsEntry): SqlRow {
  return [entry.id, entry.language, entry.lemma, entry.transliteration, entry.definition];
}

function originalWordRow(word: OriginalWord): SqlRow {
  return [word.canonicalId, word.position, word.lexeme, word.strongId, word.strongRaw, word.morphology, word.edition];
}

function edgeRow(edge: Edge): SqlRow {
  return [edge.sourceId, edge.targetId, edge.kind];
}

// --- migrations (aplicação idempotente dos .sql existentes em core/drizzle) -

/** `packages/core/drizzle/`, resolvido relativo a este módulo — não duplica os `.sql`, só os lê. */
const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../core/drizzle",
);

function readMigrationFile(migrationsDir: string, fileName: string): string {
  const filePath = path.join(migrationsDir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(
      `load/postgres: migration "${fileName}" não encontrada em "${migrationsDir}" — o N10 não gera migration ` +
        "nova, só aplica as existentes de packages/core/drizzle/",
    );
  }
  return readFileSync(filePath, "utf8");
}

// --- orquestração -------------------------------------------------------------

export interface LoadPostgresOptions {
  /** Raiz de `data/` — usada para resolver `canonicalDir`/o caminho default do derivado de embeddings. */
  dataDir: string;
  /** Diretório do JSONL canônico; default `${dataDir}/canonical`. */
  canonicalDir?: string;
  /** Caminho do derivado de embeddings; default `${dataDir}/derived/embeddings-${EXPECTED_HF_REVISION}.jsonl`. */
  embeddingsFile?: string;
  /** URL de conexão do Postgres (convenção `.env.example`: `DATABASE_URL`). */
  databaseUrl: string;
  /** Diretório das migrations do core; default `packages/core/drizzle/`. */
  migrationsDir?: string;
  /** Callback de aviso (embedding ausente etc.); default grava em stderr. */
  onWarning?: (message: string) => void;
}

export interface LoadPostgresResult {
  counts: {
    canonicalVerses: number;
    verseTexts: number;
    strongs: number;
    originalWords: number;
    edges: number;
  };
  /** `true` se o derivado de embeddings foi encontrado e joinado; `false` = todo `embedding` ficou NULL. */
  embeddingsJoined: boolean;
}

/**
 * Roda o pipeline completo: lê + revalida (Zod) o JSONL canônico → cross-
 * check de integridade referencial → resolve/joina o derivado de embeddings
 * (opcional) → aplica as migrations existentes (idempotente) → apaga e
 * regrava as 5 tabelas numa única transação (idempotente por construção —
 * duas execuções seguidas convergem para o mesmo estado).
 */
export async function loadPostgres(options: LoadPostgresOptions): Promise<LoadPostgresResult> {
  const canonicalDir = options.canonicalDir ?? path.join(options.dataDir, "canonical");
  const onWarning = options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  const data = readCanonicalData(canonicalDir);
  crossCheckIntegrity(data);

  const embeddingsFile = resolveEmbeddingsFile(options.dataDir, options.embeddingsFile);
  const embeddingByKey = loadEmbeddings(embeddingsFile, data.verseTexts, onWarning);

  const sql = postgres(options.databaseUrl, { max: 4 });
  try {
    try {
      await sql`SELECT 1`;
    } catch (error) {
      throw new Error(
        `load/postgres: não foi possível conectar ao Postgres (DATABASE_URL) — ${(error as Error).message}`,
      );
    }

    // --- migrations: cada uma só roda se o artefato que cria ainda não existir
    const canonicalVersesCheck = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'canonical_verses'
      ) AS exists
    `;
    if (canonicalVersesCheck[0]?.exists !== true) {
      await sql.unsafe(readMigrationFile(migrationsDir, "0000_init.sql"));
    }

    const editionColumnCheck = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'original_words' AND column_name = 'edition'
      ) AS exists
    `;
    if (editionColumnCheck[0]?.exists !== true) {
      await sql.unsafe(readMigrationFile(migrationsDir, "0001_original_words_edition.sql"));
    }

    // --- apaga + regrava numa única transação (idempotente) -----------------
    await sql.begin(async (tx) => {
      // Ordem inversa de FK — `edges`/`original_words`/`verse_texts` referenciam
      // `canonical_verses`; `TRUNCATE` explodiria por causa das FKs de tabelas
      // fora do escopo (`curation_log`, `reports`, `interpretations`).
      await tx`DELETE FROM edges`;
      await tx`DELETE FROM original_words`;
      await tx`DELETE FROM verse_texts`;
      await tx`DELETE FROM canonical_verses`;
      await tx`DELETE FROM strongs`;

      const exec: UnsafeExec = (query, params) => tx.unsafe(query, params);

      await bulkInsert(
        exec,
        "canonical_verses",
        CANONICAL_VERSES_COLUMNS,
        data.canonicalVerses.map(canonicalVerseRow),
        CANONICAL_VERSES_CASTS,
      );
      await bulkInsert(
        exec,
        "verse_texts",
        VERSE_TEXTS_COLUMNS,
        data.verseTexts.map((vt) => verseTextRow(vt, embeddingByKey)),
        VERSE_TEXTS_CASTS,
      );
      await bulkInsert(exec, "strongs", STRONGS_COLUMNS, data.strongsEntries.map(strongsRow), {});
      await bulkInsert(exec, "original_words", ORIGINAL_WORDS_COLUMNS, data.originalWords.map(originalWordRow), {});
      await bulkInsert(exec, "edges", EDGES_COLUMNS, data.edges.map(edgeRow), EDGES_CASTS);
    });
  } finally {
    await sql.end();
  }

  return {
    counts: {
      canonicalVerses: data.canonicalVerses.length,
      verseTexts: data.verseTexts.length,
      strongs: data.strongsEntries.length,
      originalWords: data.originalWords.length,
      edges: data.edges.length,
    },
    embeddingsJoined: embeddingByKey !== null,
  };
}

// --- CLI ----------------------------------------------------------------------

function resolveDataDir(): string {
  const fromEnv = process.env["DATA_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve("./data");
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const canonicalDir = process.env["CANONICAL_DIR"];
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("load/postgres: variável de ambiente DATABASE_URL ausente (ver .env.example)");
  }
  const embeddingsFile = process.env["EMBEDDINGS_FILE"];
  const migrationsDir = process.env["MIGRATIONS_DIR"];

  process.stdout.write(`load:postgres — DATA_DIR=${dataDir} DATABASE_URL=${databaseUrl}\n`);
  const result = await loadPostgres({
    dataDir,
    databaseUrl,
    ...(canonicalDir !== undefined ? { canonicalDir } : {}),
    ...(embeddingsFile !== undefined ? { embeddingsFile } : {}),
    ...(migrationsDir !== undefined ? { migrationsDir } : {}),
  });
  process.stdout.write(`load:postgres — OK: ${JSON.stringify(result, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
