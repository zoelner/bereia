import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  USED_SOURCES,
  buildCanonical,
  verifySourceManifest,
  type BuildCanonicalResult,
} from "./build-canonical.js";
import { buildManifest, serializeBuildManifest, type SourceProvenance } from "./build-manifest.js";

/**
 * N8 — CLI `build:canonical` (plano de fechamento da Fase 1 §4/§5).
 *
 * Duas camadas (ADR-008):
 * - UNIT (sempre roda, sem I/O de fontes reais): `verifySourceManifest` contra
 *   um `manifest.json` SINTÉTICO num diretório temporário (nunca as fontes
 *   teológicas reais) e `buildManifest`/`serializeBuildManifest` com contagens
 *   mock — cobre os caminhos de erro (sha256 divergente, fonte ausente,
 *   formato desconhecido) sem depender de `data/sources/`.
 * - INTEGRAÇÃO (skipIf, contra `data/sources/` reais): roda o pipeline
 *   completo DUAS VEZES em diretórios temporários distintos e compara TODOS os
 *   arquivos byte a byte (determinismo, plano §5: "re-run → git diff vazio").
 *   Números EXATOS atrelados ao manifest (mesmas âncoras de N5/N6/N7).
 */

// --- unit: verifySourceManifest (manifest sintético, estrutura neutra) -----

function makeTempSourcesDir(): string {
  return mkdtempSync(path.join(tmpdir(), "bereia-n8-manifest-"));
}

describe("verifySourceManifest — unit (manifest sintético, sem dado teológico)", () => {
  it("EXPLODE quando manifest.json está ausente", () => {
    const dir = makeTempSourcesDir();
    expect(() => verifySourceManifest(dir)).toThrow(/manifest de proveniência ausente/);
  });

  it("EXPLODE agregando TODAS as fontes usadas ausentes do manifest (não só a primeira)", () => {
    const dir = makeTempSourcesDir();
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ sources: {} }));
    try {
      verifySourceManifest(dir);
      throw new Error("deveria ter explodido");
    } catch (error) {
      const message = (error as Error).message;
      for (const key of USED_SOURCES) {
        expect(message, `mensagem deveria citar "${key}"`).toContain(key);
      }
    }
  });

  it("EXPLODE quando o sha256 em disco não bate o manifest (formato file+sha256, ex.: zip)", () => {
    const dir = makeTempSourcesDir();
    mkdirSync(path.join(dir, "eng-kjv"), { recursive: true });
    writeFileSync(path.join(dir, "eng-kjv", "mock.zip"), "mock conteúdo, não é dado teológico real");
    const sources: Record<string, unknown> = {};
    for (const key of USED_SOURCES) sources[key] = { file: "eng-kjv/mock.zip", sha256: "0".repeat(64) };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ sources }));
    expect(() => verifySourceManifest(dir)).toThrow(/sha256 de "eng-kjv\/mock\.zip" não bate/);
  });

  it("EXPLODE quando um arquivo listado em 'files' está ausente em disco", () => {
    const dir = makeTempSourcesDir();
    const sources: Record<string, unknown> = {};
    for (const key of USED_SOURCES) sources[key] = { files: { [`${key}/mock.txt`]: "a".repeat(64) } };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ sources }));
    expect(() => verifySourceManifest(dir)).toThrow(/ausente em disco/);
  });

  it("EXPLODE quando a fonte tem status (ex.: QUARANTINED) — nunca usa fonte marcada", () => {
    const dir = makeTempSourcesDir();
    const sources: Record<string, unknown> = {};
    for (const key of USED_SOURCES) sources[key] = { status: "QUARANTINED" };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ sources }));
    expect(() => verifySourceManifest(dir)).toThrow(/status "QUARANTINED"/);
  });

  it("passa e devolve a proveniência quando todo arquivo casa o sha256 pinado (mock estrutural)", () => {
    const dir = makeTempSourcesDir();
    const sources: Record<string, unknown> = {};
    for (const key of USED_SOURCES) {
      mkdirSync(path.join(dir, key), { recursive: true });
      const content = `mock estrutura sintética de "${key}", sem conteúdo teológico`;
      writeFileSync(path.join(dir, key, "mock.txt"), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      sources[key] = { files: { [`${key}/mock.txt`]: sha256 } };
    }
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ sources }));
    const provenance = verifySourceManifest(dir);
    expect(provenance.map(([key]) => key).sort()).toEqual([...USED_SOURCES].sort());
  });
});

// --- unit: buildManifest/serializeBuildManifest (contagens mock) -----------

describe("buildManifest/serializeBuildManifest — unit (contagens sintéticas)", () => {
  const mockSources: (readonly [string, SourceProvenance])[] = [
    ["mock-a", { kind: "single", path: "mock-a/file.zip", sha256: "0".repeat(64) }],
    ["mock-b", { kind: "files", files: [{ path: "mock-b/f1.txt", sha256: "1".repeat(64) }] }],
  ];

  it("soma verseTexts/strongs a partir dos totais por categoria; chaves em ordem fixa", () => {
    const manifest = buildManifest({
      canonicalVersesCount: 3,
      verseTextsByTranslation: { KJV: 3, BLIVRE: 2, WEB: 1 },
      originalWordsCount: 5,
      strongsByLanguage: { hebrew: 2, greek: 1 },
      edgesCount: 4,
      sources: mockSources,
    });
    expect(manifest.tables.verseTexts.count).toBe(6);
    expect(manifest.tables.strongs.count).toBe(3);
    expect(manifest.tables.edges.kind).toBe("tsk");

    const json = serializeBuildManifest(manifest);
    expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual(["schemaVersion", "tables", "sources"]);
  });

  it("serialização não tem timestamp/hostname e termina com LF (determinismo)", () => {
    const manifest = buildManifest({
      canonicalVersesCount: 1,
      verseTextsByTranslation: { KJV: 1, BLIVRE: 1, WEB: 1 },
      originalWordsCount: 1,
      strongsByLanguage: { hebrew: 1, greek: 0 },
      edgesCount: 0,
      sources: mockSources,
    });
    const json = serializeBuildManifest(manifest);
    expect(json).not.toMatch(/timestamp|hostname|pid/i);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("mesma entrada produz os MESMOS bytes (determinismo de serialização)", () => {
    const input = {
      canonicalVersesCount: 1,
      verseTextsByTranslation: { KJV: 1, BLIVRE: 1, WEB: 1 },
      originalWordsCount: 1,
      strongsByLanguage: { hebrew: 1, greek: 0 },
      edgesCount: 0,
      sources: mockSources,
    };
    const a = serializeBuildManifest(buildManifest(input));
    const b = serializeBuildManifest(buildManifest(input));
    expect(a).toBe(b);
  });
});

// --- integração: pipeline completo contra fontes REAIS ----------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const sourcesDir = path.join(dataDir, "sources");

const REQUIRED_FILES = [
  path.join(sourcesDir, "manifest.json"),
  path.join(sourcesDir, "eng-kjv/eng-kjv_usfx.xml"),
  path.join(sourcesDir, "eng-web/engwebp_usfx.xml"),
  path.join(sourcesDir, "por-biblialivre/porbr2018_usfx.xml"),
  path.join(sourcesDir, "stepbible-tvtms/TVTMS.txt"),
  path.join(sourcesDir, "stepbible-tahot/TAHOT_Gen-Deu.txt"),
  path.join(sourcesDir, "stepbible-tagnt/TAGNT_Mat-Jhn.txt"),
  path.join(sourcesDir, "strongs/StrongHebrewG.xml"),
  path.join(sourcesDir, "strongs/strongsgreek.xml"),
  path.join(sourcesDir, "openbible-xrefs/cross_references.txt"),
];
const hasAll = REQUIRED_FILES.every((f) => existsSync(f));

/** Números EXATOS atrelados às fontes pinadas (mesmas âncoras de N5/N6/N7). */
const CANONICAL_VERSES = 31_218;
const VERSE_TEXTS_BY_TRANSLATION = { KJV: 31_218, BLIVRE: 31_217, WEB: 31_211 };
const VERSE_TEXTS_TOTAL = 93_646;
const ORIGINAL_WORDS = 447_734;
const STRONGS_BY_LANGUAGE = { hebrew: 8_674, greek: 5_624 };
const STRONGS_TOTAL = 14_298;
const EDGES = 614_208;

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").filter((l) => l.length > 0).length;
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

describe.skipIf(!hasAll)("N8 integração — build:canonical (pipeline completo, fontes reais)", () => {
  let outDirA: string;
  let outDirB: string;
  let resultA: BuildCanonicalResult;

  // Duas execuções COMPLETAS (parse + build + gravação) em diretórios
  // distintos — é o requisito do plano §5 ("re-run → git diff vazio"), não só
  // um round-trip de serialização. Timeout generoso: o pipeline completo (3
  // Bíblias USFX, TVTMS, TAHOT/TAGNT, Strong, xrefs) roda em ~15s em máquina
  // desimpedida, mas builds sob carga do pool de testes precisam de folga.
  beforeAll(() => {
    outDirA = mkdtempSync(path.join(tmpdir(), "bereia-build-canonical-a-"));
    outDirB = mkdtempSync(path.join(tmpdir(), "bereia-build-canonical-b-"));
    resultA = buildCanonical({ dataDir, outDir: outDirA });
    buildCanonical({ dataDir, outDir: outDirB });
  }, 300_000);

  afterAll(() => {
    rmSync(outDirA, { recursive: true, force: true });
    rmSync(outDirB, { recursive: true, force: true });
  });

  it("grava o layout OQ-1 completo", () => {
    expect(existsSync(path.join(outDirA, "canonical_verses.jsonl"))).toBe(true);
    expect(existsSync(path.join(outDirA, "strongs.jsonl"))).toBe(true);
    expect(existsSync(path.join(outDirA, "edges.jsonl"))).toBe(true);
    expect(existsSync(path.join(outDirA, "BUILD_MANIFEST.json"))).toBe(true);
    expect(existsSync(path.join(outDirA, "verse_texts"))).toBe(true);
    expect(existsSync(path.join(outDirA, "original_words"))).toBe(true);
  });

  it("BUILD_MANIFEST.json: contagens EXATAS (âncora ADR-008, mesmos números de N5/N6/N7)", () => {
    const { tables } = resultA.manifest;
    expect(tables.canonicalVerses.count).toBe(CANONICAL_VERSES);
    expect(tables.verseTexts.count).toBe(VERSE_TEXTS_TOTAL);
    expect(tables.verseTexts.byTranslation).toEqual(VERSE_TEXTS_BY_TRANSLATION);
    expect(tables.originalWords.count).toBe(ORIGINAL_WORDS);
    expect(tables.strongs.count).toBe(STRONGS_TOTAL);
    expect(tables.strongs.byLanguage).toEqual(STRONGS_BY_LANGUAGE);
    expect(tables.edges.count).toBe(EDGES);
    expect(tables.edges.kind).toBe("tsk");
  });

  it("BUILD_MANIFEST.json: proveniência cobre exatamente USED_SOURCES, sem timestamp/hostname", () => {
    expect(Object.keys(resultA.manifest.sources).sort()).toEqual([...USED_SOURCES].sort());
    const raw = readFileSync(path.join(outDirA, "BUILD_MANIFEST.json"), "utf8");
    expect(raw).not.toMatch(/timestamp|hostname|\bpid\b/i);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it(
    "re-run em diretórios distintos produz o MESMO conjunto de arquivos",
    () => {
      const filesA = listFilesRecursive(outDirA);
      const filesB = listFilesRecursive(outDirB);
      expect(filesA).toEqual(filesB);
      // 66 livros em cada tabela particionada + 4 arquivos de topo (canonical_verses, strongs, edges, manifest).
      expect(filesA.length).toBeGreaterThanOrEqual(66 + 66 + 4);
    },
    30_000,
  );

  it(
    "re-run é BYTE A BYTE idêntico em TODOS os arquivos (determinismo, plano §5)",
    () => {
      const files = listFilesRecursive(outDirA);
      for (const rel of files) {
        const a = readFileSync(path.join(outDirA, rel));
        const b = readFileSync(path.join(outDirB, rel));
        expect(a.equals(b), `arquivo divergente entre re-runs: ${rel}`).toBe(true);
      }
    },
    60_000,
  );

  it(
    "canonical_verses.jsonl tem exatamente CANONICAL_VERSES linhas, cada uma parseável",
    () => {
      const content = readFileSync(path.join(outDirA, "canonical_verses.jsonl"), "utf8");
      expect(countLines(content)).toBe(CANONICAL_VERSES);
      expect(content.endsWith("\n")).toBe(true);
    },
    30_000,
  );

  it(
    "verse_texts/{BOOK}.jsonl: soma das linhas por arquivo bate o total do manifest",
    () => {
      const dir = path.join(outDirA, "verse_texts");
      let total = 0;
      for (const f of readdirSync(dir)) total += countLines(readFileSync(path.join(dir, f), "utf8"));
      expect(total).toBe(VERSE_TEXTS_TOTAL);
    },
    30_000,
  );

  it(
    "original_words/{BOOK}.jsonl: soma das linhas por arquivo bate o total do manifest",
    () => {
      const dir = path.join(outDirA, "original_words");
      let total = 0;
      for (const f of readdirSync(dir)) total += countLines(readFileSync(path.join(dir, f), "utf8"));
      expect(total).toBe(ORIGINAL_WORDS);
    },
    30_000,
  );

  it(
    "edges.jsonl e strongs.jsonl têm exatamente as contagens do manifest",
    () => {
      expect(countLines(readFileSync(path.join(outDirA, "edges.jsonl"), "utf8"))).toBe(EDGES);
      expect(countLines(readFileSync(path.join(outDirA, "strongs.jsonl"), "utf8"))).toBe(STRONGS_TOTAL);
    },
    30_000,
  );

  it("re-executar verifySourceManifest contra a mesma DATA_DIR não explode (fontes íntegras)", () => {
    expect(() => verifySourceManifest(sourcesDir)).not.toThrow();
  });
});

if (!hasAll) {
  it("fontes reais ausentes — integração de build:canonical PULADA (ver data/sources/manifest.json)", () => {
    expect(hasAll).toBe(false);
  });
}
