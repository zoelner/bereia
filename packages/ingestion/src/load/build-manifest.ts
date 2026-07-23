/**
 * Montagem do `BUILD_MANIFEST.json` (N8, plano de fechamento da Fase 1 §3.3/§4).
 * Função PURA: recebe as contagens/estatísticas já calculadas por
 * `build-canonical.ts` e devolve um objeto determinístico pronto para
 * serializar — não lê disco nem rede, não tem relógio.
 *
 * ## Determinismo (requisito de produto — CLAUDE.md §1/§7)
 * O manifest é uma ÂNCORA de reprodutibilidade (ADR-008: contagens exatas
 * atreladas ao sha256 das fontes pinadas). Por isso:
 * - **PROIBIDO** qualquer campo dependente de relógio/ambiente (timestamp,
 *   hostname, PID, caminho absoluto do sistema de arquivos). O schema Zod
 *   abaixo é FECHADO (`.strict()`): um campo não previsto explode na gravação,
 *   nunca passa silenciosamente.
 * - Chaves em ORDEM FIXA (ordem de declaração do objeto — `JSON.stringify`
 *   preserva ordem de inserção de chaves string), terminador LF.
 * - `sources` é construído iterando `USED_SOURCES` (lista fixa em
 *   `build-canonical.ts`), nunca `Object.keys` do manifest de proveniência
 *   bruto (ordem de um JSON externo não é uma garantia de produto).
 */

import { z } from "zod";

/** Uma fonte pinada por sha256 único (ex.: o zip de uma tradução USFX). */
const singleFileProvenanceSchema = z
  .object({
    kind: z.literal("single"),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Uma fonte pinada por sha256 de múltiplos arquivos (ex.: os 4 TSV do TAHOT). */
const multiFileProvenanceSchema = z
  .object({
    kind: z.literal("files"),
    files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
  })
  .strict();

const sourceProvenanceSchema = z.union([singleFileProvenanceSchema, multiFileProvenanceSchema]);
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

const verseTextsByTranslationSchema = z.object({
  KJV: z.number().int().nonnegative(),
  BLIVRE: z.number().int().nonnegative(),
  WEB: z.number().int().nonnegative(),
});

const strongsByLanguageSchema = z.object({
  hebrew: z.number().int().nonnegative(),
  greek: z.number().int().nonnegative(),
});

export const buildManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    tables: z
      .object({
        canonicalVerses: z
          .object({ file: z.literal("canonical_verses.jsonl"), count: z.number().int().nonnegative() })
          .strict(),
        verseTexts: z
          .object({
            dir: z.literal("verse_texts"),
            count: z.number().int().nonnegative(),
            byTranslation: verseTextsByTranslationSchema,
          })
          .strict(),
        originalWords: z
          .object({ dir: z.literal("original_words"), count: z.number().int().nonnegative() })
          .strict(),
        strongs: z
          .object({
            file: z.literal("strongs.jsonl"),
            count: z.number().int().nonnegative(),
            byLanguage: strongsByLanguageSchema,
          })
          .strict(),
        edges: z
          .object({
            file: z.literal("edges.jsonl"),
            count: z.number().int().nonnegative(),
            kind: z.literal("tsk"),
          })
          .strict(),
      })
      .strict(),
    sources: z.record(z.string(), sourceProvenanceSchema),
  })
  .strict();

export type BuildManifest = z.infer<typeof buildManifestSchema>;

export interface BuildManifestInput {
  canonicalVersesCount: number;
  verseTextsByTranslation: { KJV: number; BLIVRE: number; WEB: number };
  originalWordsCount: number;
  strongsByLanguage: { hebrew: number; greek: number };
  edgesCount: number;
  /** Proveniência das fontes usadas, na ORDEM em que devem aparecer no manifest. */
  sources: readonly (readonly [sourceKey: string, provenance: SourceProvenance])[];
}

/**
 * Monta o `BUILD_MANIFEST.json` a partir das contagens já calculadas. Valida
 * pelo schema fechado acima (fronteira, CLAUDE.md §7) — garante que nenhum
 * campo não-determinístico (timestamp, hostname) escape para o artefato.
 */
export function buildManifest(input: BuildManifestInput): BuildManifest {
  const verseTextsTotal =
    input.verseTextsByTranslation.KJV + input.verseTextsByTranslation.BLIVRE + input.verseTextsByTranslation.WEB;
  const strongsTotal = input.strongsByLanguage.hebrew + input.strongsByLanguage.greek;

  const sources: Record<string, SourceProvenance> = {};
  for (const [key, provenance] of input.sources) {
    sources[key] = provenance;
  }

  return buildManifestSchema.parse({
    schemaVersion: 1,
    tables: {
      canonicalVerses: { file: "canonical_verses.jsonl", count: input.canonicalVersesCount },
      verseTexts: {
        dir: "verse_texts",
        count: verseTextsTotal,
        byTranslation: input.verseTextsByTranslation,
      },
      originalWords: { dir: "original_words", count: input.originalWordsCount },
      strongs: { file: "strongs.jsonl", count: strongsTotal, byLanguage: input.strongsByLanguage },
      edges: { file: "edges.jsonl", count: input.edgesCount, kind: "tsk" },
    },
    sources,
  });
}

/**
 * Serializa o manifest em JSON determinístico: 2 espaços de indentação
 * (legibilidade — não afeta o requisito de determinismo, só precisa ser
 * ESTÁVEL entre execuções, o que `JSON.stringify` sobre um objeto sem `Map`/
 * `Set`/relógio garante), terminador LF.
 */
export function serializeBuildManifest(manifest: BuildManifest): string {
  return JSON.stringify(buildManifestSchema.parse(manifest), null, 2) + "\n";
}
