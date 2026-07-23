#!/usr/bin/env node
/**
 * CLI `build:canonical` (N8, plano de fechamento da Fase 1 §3.3/§4): orquestra
 * os builds prontos dos nós anteriores — N5 (`verses.ts`), N6 (`words.ts`), N7
 * (`edges.ts`) — e grava o JSONL canônico (`data/canonical/`, FONTE DE VERDADE
 * no Git, CLAUDE.md §4) no layout OQ-1 exato:
 *
 * ```
 * canonical_verses.jsonl
 * verse_texts/{BOOK}.jsonl        # particionado por livro
 * original_words/{BOOK}.jsonl     # particionado por livro
 * strongs.jsonl
 * edges.jsonl
 * BUILD_MANIFEST.json
 * ```
 *
 * Este módulo NÃO reimplementa build/parse: apenas lê os arquivos brutos de
 * `DATA_DIR/sources/`, chama os ports prontos (parsers + `load/verses.ts`,
 * `load/words.ts`, `load/edges.ts`) e grava via o writer determinístico do N4
 * (`load/jsonl.ts` — Zod na gravação já embutido lá, não duplicado aqui).
 *
 * ## Cadeia auditável (ADR-006)
 * ANTES de parsear qualquer fonte, `verifySourceManifest` confere o sha256 de
 * cada arquivo usado contra `data/sources/manifest.json` — determinismo é
 * requisito de produto (CLAUDE.md §1/§7): fonte re-baixada/alterada sem
 * atualizar o manifest faz o build ABORTAR ruidosamente, nunca gravar dado
 * potencialmente inconsistente.
 *
 * ## Determinismo de gravação
 * `verse_texts` e `original_words` são combinados (3 traduções / TAHOT+TAGNT)
 * e reordenados pelos comparadores canônicos do N4 ANTES de particionar por
 * livro — a partição em si não introduz não-determinismo porque cada arquivo
 * recebe um subconjunto CONTÍGUO de uma lista já totalmente ordenada. Re-run
 * com as mesmas fontes pinadas produz bytes idênticos em todo `OUT_DIR`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { parseCanonicalId, USFM_BOOKS, type UsfmBook, type VerseText } from "@bereia/core";
import { parseUsfx, usfxSourceInventory, usfxStandardInventory, type UsfxBible } from "../parsers/usfx.js";
import { loadTvtms } from "../parsers/tvtms.js";
import { parseStrongsDict } from "../parsers/strongs/index.js";
import { parseXrefs } from "../parsers/xrefs/parser.js";
import { buildCanonicalVerses, buildVerseTexts, canonicalIdSet } from "./verses.js";
import { buildOriginalWords, referencedStrongIds, wordBook } from "./words.js";
import { buildEdges } from "./edges.js";
import { compareStrongsEntry, compareVerseText, sortDeterministic } from "./order.js";
import {
  writeCanonicalVerses,
  writeEdges,
  writeOriginalWords,
  writeStrongsEntries,
  writeVerseTexts,
} from "./jsonl.js";
import { buildManifest, serializeBuildManifest, type BuildManifest, type SourceProvenance } from "./build-manifest.js";

// --- verificação de proveniência (sha256 contra o manifest de fontes) -------

/**
 * Fontes usadas por este build, na ORDEM em que aparecem em `BUILD_MANIFEST.
 * json.sources` (fixa — não deriva de `Object.keys` do manifest bruto, ver
 * cabeçalho do módulo `build-manifest.ts`). `por-almeida` é deliberadamente
 * excluída (QUARANTINED, plano §2/CLAUDE.md §3 — nunca ingerida).
 */
export const USED_SOURCES = [
  "eng-kjv",
  "eng-web",
  "por-biblialivre",
  "stepbible-tvtms",
  "stepbible-tahot",
  "stepbible-tagnt",
  "strongs",
  "openbible-xrefs",
] as const;

const manifestSourceEntrySchema = z
  .object({
    status: z.string().optional(),
    file: z.string().optional(),
    sha256: z.string().optional(),
    files: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const sourceManifestSchema = z.object({ sources: z.record(z.string(), manifestSourceEntrySchema) }).passthrough();

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Confere o sha256 de cada arquivo de `USED_SOURCES` contra
 * `${sourcesDir}/manifest.json` ANTES de qualquer parse. Duas formas reais de
 * proveniência coexistem no manifest (plano §2, levantado do dado real):
 * - `files`: mapa `caminho relativo → sha256` (TAHOT/TAGNT/strongs — arquivos
 *   extraídos, os mesmos que os parsers leem).
 * - `file` + `sha256`: um único arquivo pinado (o `.zip` baixado — as 3
 *   traduções USFX, TVTMS e o xrefs só pinam o zip; o `.xml`/`.txt` extraído
 *   que os parsers leem não tem sha256 individual no manifest hoje). A
 *   verificação aqui é o melhor esforço possível dado o formato REAL do
 *   manifest — reportado em `notes` do nó, não uma limitação inventada.
 *
 * Explode com TODAS as divergências agregadas numa única mensagem (nunca só a
 * primeira) — depuração de um re-download parcial não deveria exigir rodar o
 * build várias vezes só para descobrir o próximo arquivo divergente.
 */
export function verifySourceManifest(
  sourcesDir: string,
): readonly (readonly [string, SourceProvenance])[] {
  const manifestPath = path.join(sourcesDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `build-canonical: manifest de proveniência ausente em "${manifestPath}" — rode a ingestão de fontes ` +
        "antes de build:canonical (ver docs/mapa-de-fontes.md)",
    );
  }
  const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));

  const provenance: [string, SourceProvenance][] = [];
  const problems: string[] = [];

  for (const key of USED_SOURCES) {
    const entry = manifest.sources[key];
    if (entry === undefined) {
      problems.push(`fonte "${key}" ausente de manifest.json`);
      continue;
    }
    if (entry.status !== undefined) {
      problems.push(`fonte "${key}" tem status "${entry.status}" — não deveria ser usada por build:canonical`);
      continue;
    }
    if (entry.files !== undefined) {
      const relPaths = Object.keys(entry.files).sort();
      const files: { path: string; sha256: string }[] = [];
      for (const relPath of relPaths) {
        const expected = entry.files[relPath] as string;
        const absPath = path.join(sourcesDir, relPath);
        if (!existsSync(absPath)) {
          problems.push(`fonte "${key}": arquivo "${relPath}" ausente em disco`);
          continue;
        }
        const actual = sha256File(absPath);
        if (actual !== expected) {
          problems.push(
            `fonte "${key}": sha256 de "${relPath}" não bate — manifest="${expected}" disco="${actual}"`,
          );
          continue;
        }
        files.push({ path: relPath, sha256: actual });
      }
      if (files.length === relPaths.length) provenance.push([key, { kind: "files", files }]);
      continue;
    }
    if (entry.file !== undefined && entry.sha256 !== undefined) {
      const absPath = path.join(sourcesDir, entry.file);
      if (!existsSync(absPath)) {
        problems.push(`fonte "${key}": arquivo "${entry.file}" ausente em disco`);
        continue;
      }
      const actual = sha256File(absPath);
      if (actual !== entry.sha256) {
        problems.push(
          `fonte "${key}": sha256 de "${entry.file}" não bate — manifest="${entry.sha256}" disco="${actual}"`,
        );
        continue;
      }
      provenance.push([key, { kind: "single", path: entry.file, sha256: actual }]);
      continue;
    }
    problems.push(`fonte "${key}": manifest não tem nem "files" nem "file"+"sha256" (formato desconhecido)`);
  }

  if (problems.length > 0) {
    throw new Error(
      "build-canonical: verificação de proveniência (sha256) falhou — determinismo é requisito de produto, " +
        `o build ABORTA antes de parsear:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  return provenance;
}

// --- orquestração do build ---------------------------------------------------

const TAHOT_FILES = ["TAHOT_Gen-Deu.txt", "TAHOT_Jos-Est.txt", "TAHOT_Job-Sng.txt", "TAHOT_Isa-Mal.txt"] as const;
const TAGNT_FILES = ["TAGNT_Mat-Jhn.txt", "TAGNT_Act-Rev.txt"] as const;

/**
 * Tradição de versificação declarada para as 3 fontes USFX no desempate
 * TVTMS. "Hebrew" (não "Eng-KJV") é a escolha fixada em `verses.ts` — ver o
 * comentário de topo daquele módulo para a evidência completa (varredura
 * exaustiva: só as 5 refs de Ester divergem).
 */
const VERSIFICATION_TRADITION = "Hebrew";

export interface BuildCanonicalOptions {
  /** Raiz de `data/` (contém `sources/`). */
  dataDir: string;
  /** Diretório de saída do JSONL canônico. O conteúdo anterior é APAGADO antes de gravar (build limpo, determinístico). */
  outDir: string;
  /** Teto de descarte de `verse_texts` fora do inventário-mestre (OQ-4). Default do `buildVerseTexts` (0,5%). */
  maxVerseDropRate?: number;
  /** Teto de descarte de `edges` fora do inventário-mestre (OQ-4). Default do `buildEdges` (0,5%). */
  maxEdgeDiscardRate?: number;
}

export interface BuildCanonicalResult {
  manifest: BuildManifest;
}

/** Agrupa `items` já ordenados por `bookOf(item)`, preservando a ordem relativa (grupos contíguos). */
function partitionByBook<T>(items: readonly T[], bookOf: (item: T) => UsfmBook): Map<UsfmBook, T[]> {
  const partitions = new Map<UsfmBook, T[]>();
  for (const item of items) {
    const book = bookOf(item);
    const bucket = partitions.get(book);
    if (bucket === undefined) partitions.set(book, [item]);
    else bucket.push(item);
  }
  return partitions;
}

/** Grava um arquivo por livro (ordem do cânon, `USFM_BOOKS`) — livro sem linha não gera arquivo. */
function writePartitionedByBook<T>(
  dir: string,
  items: readonly T[],
  bookOf: (item: T) => UsfmBook,
  serialize: (records: readonly T[]) => string,
): void {
  const partitions = partitionByBook(items, bookOf);
  for (const book of USFM_BOOKS) {
    const records = partitions.get(book);
    if (records === undefined || records.length === 0) continue;
    writeFileSync(path.join(dir, `${book}.jsonl`), serialize(records));
  }
}

/**
 * Orquestra o pipeline completo: verifica proveniência → parseia as fontes →
 * builda as 5 tabelas (N5/N6/N1/N7) → grava o JSONL canônico + o
 * `BUILD_MANIFEST.json` no layout OQ-1. Função pura em relação ao processo
 * (sem `process.exit`/`console.log`) — o wrapper de CLI abaixo cuida disso —
 * para o teste chamar diretamente contra diretórios temporários.
 */
export function buildCanonical(options: BuildCanonicalOptions): BuildCanonicalResult {
  const sourcesDir = path.join(options.dataDir, "sources");
  const provenance = verifySourceManifest(sourcesDir);
  const src = (rel: string): string => path.join(sourcesDir, rel);

  // --- parse das 3 Bíblias USFX + TVTMS -----------------------------------
  const kjv = parseUsfx(readFileSync(src("eng-kjv/eng-kjv_usfx.xml"), "utf8"));
  const web = parseUsfx(readFileSync(src("eng-web/engwebp_usfx.xml"), "utf8"));
  const blivre = parseUsfx(readFileSync(src("por-biblialivre/porbr2018_usfx.xml"), "utf8"));
  const tvtmsTsv = readFileSync(src("stepbible-tvtms/TVTMS.txt"), "utf8");
  const standardInventory = usfxStandardInventory(kjv);

  // --- canonical_verses + verse_texts (N5) --------------------------------
  const canonicalVerses = buildCanonicalVerses(kjv);
  const inventory = canonicalIdSet(canonicalVerses);

  const translations: readonly { name: "KJV" | "BLIVRE" | "WEB"; bible: UsfxBible }[] = [
    { name: "KJV", bible: kjv },
    { name: "BLIVRE", bible: blivre },
    { name: "WEB", bible: web },
  ];

  const verseTextsAll: VerseText[] = [];
  const verseTextsByTranslation = { KJV: 0, BLIVRE: 0, WEB: 0 };
  for (const { name, bible } of translations) {
    const mapper = loadTvtms(tvtmsTsv, usfxSourceInventory(bible), standardInventory);
    const { verseTexts, stats } = buildVerseTexts({
      source: bible,
      translation: name,
      versificationTradition: VERSIFICATION_TRADITION,
      mapper,
      inventory,
      ...(options.maxVerseDropRate === undefined ? {} : { maxDropRate: options.maxVerseDropRate }),
    });
    verseTextsAll.push(...verseTexts);
    verseTextsByTranslation[name] = stats.emitted;
  }

  // --- original_words (N6, sobre TAHOT/TAGNT) ------------------------------
  const tahotTsvs = TAHOT_FILES.map((f) => readFileSync(src(`stepbible-tahot/${f}`), "utf8"));
  const tagntTsvs = TAGNT_FILES.map((f) => readFileSync(src(`stepbible-tagnt/${f}`), "utf8"));
  const originalWords = buildOriginalWords({ tahot: tahotTsvs, tagnt: tagntTsvs });

  // --- strongs.jsonl (N1) ---------------------------------------------------
  const strongsEntries = sortDeterministic(
    parseStrongsDict({
      hebrewXml: readFileSync(src("strongs/StrongHebrewG.xml"), "utf8"),
      greekXml: readFileSync(src("strongs/strongsgreek.xml"), "utf8"),
    }),
    compareStrongsEntry,
  );

  // FK real (mesma invariante provada em words.test.ts): todo strongId
  // não-nulo de original_words precisa existir em strongs.jsonl. O build
  // ABORTA antes de gravar qualquer arquivo se a FK quebrar — nunca grava
  // dado canônico inconsistente (CLAUDE.md §7).
  const dictIds = new Set(strongsEntries.map((entry) => entry.id));
  const unresolvedStrongIds = [...referencedStrongIds(originalWords)].filter((id) => !dictIds.has(id));
  if (unresolvedStrongIds.length > 0) {
    throw new Error(
      `build-canonical: ${String(unresolvedStrongIds.length)} strongId de original_words sem entrada em ` +
        `strongs.jsonl (quebra a FK) — amostra: ${unresolvedStrongIds.slice(0, 10).join(", ")}`,
    );
  }

  // --- edges (N7, sobre openbible-xrefs) ------------------------------------
  const parsedXrefs = parseXrefs(readFileSync(src("openbible-xrefs/cross_references.txt"), "utf8"));
  const edgesResult = buildEdges({
    edges: parsedXrefs.edges,
    deferredRanges: parsedXrefs.deferredRanges,
    inventory: canonicalVerses,
    ...(options.maxEdgeDiscardRate === undefined ? {} : { maxDiscardRate: options.maxEdgeDiscardRate }),
  });

  // --- gravação determinística (layout OQ-1) --------------------------------
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  writeFileSync(path.join(options.outDir, "canonical_verses.jsonl"), writeCanonicalVerses(canonicalVerses));

  const verseTextsDir = path.join(options.outDir, "verse_texts");
  mkdirSync(verseTextsDir, { recursive: true });
  writePartitionedByBook(
    verseTextsDir,
    sortDeterministic(verseTextsAll, compareVerseText),
    (verseText) => parseCanonicalId(verseText.canonicalId).book,
    writeVerseTexts,
  );

  const originalWordsDir = path.join(options.outDir, "original_words");
  mkdirSync(originalWordsDir, { recursive: true });
  writePartitionedByBook(originalWordsDir, originalWords, wordBook, writeOriginalWords);

  writeFileSync(path.join(options.outDir, "strongs.jsonl"), writeStrongsEntries(strongsEntries));
  writeFileSync(path.join(options.outDir, "edges.jsonl"), writeEdges(edgesResult.edges));

  const strongsByLanguage = { hebrew: 0, greek: 0 };
  for (const entry of strongsEntries) strongsByLanguage[entry.language]++;

  const manifest = buildManifest({
    canonicalVersesCount: canonicalVerses.length,
    verseTextsByTranslation,
    originalWordsCount: originalWords.length,
    strongsByLanguage,
    edgesCount: edgesResult.edges.length,
    sources: provenance,
  });
  writeFileSync(path.join(options.outDir, "BUILD_MANIFEST.json"), serializeBuildManifest(manifest));

  return { manifest };
}

// --- CLI --------------------------------------------------------------------

function resolveDataDir(): string {
  const fromEnv = process.env["DATA_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  return path.join(repoRoot, "data");
}

function resolveOutDir(dataDir: string): string {
  const fromEnv = process.env["OUT_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(dataDir, "canonical");
}

function main(): void {
  const dataDir = resolveDataDir();
  const outDir = resolveOutDir(dataDir);
  process.stdout.write(`build:canonical — DATA_DIR=${dataDir} OUT_DIR=${outDir}\n`);
  const { manifest } = buildCanonical({ dataDir, outDir });
  process.stdout.write(`build:canonical — OK: ${JSON.stringify(manifest.tables, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
