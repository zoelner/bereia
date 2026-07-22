import { z } from "zod";
import { canonicalIdSchema, usfmBookSchema } from "./canon.js";

export const canonStatusSchema = z.enum(["protestant", "deuterocanonical"]);
export type CanonStatus = z.infer<typeof canonStatusSchema>;

export const edgeKindSchema = z.enum(["tsk", "thematic", "manual"]);
export type EdgeKind = z.infer<typeof edgeKindSchema>;

/** Níveis de acesso do hard filter (ADR-004). Aplicado ANTES do ranking vetorial. */
export const accessLevelSchema = z.enum(["public", "curated"]);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

export const userSchema = z.object({
  id: z.string().min(1),
  accessLevels: z.array(accessLevelSchema).min(1),
});
export type User = z.infer<typeof userSchema>;

export const canonicalVerseSchema = z.object({
  id: canonicalIdSchema,
  book: usfmBookSchema,
  chapter: z.number().int().positive(),
  /** 0 = título de Salmo (ex.: PSA_3_0); o pipeline produz canonical_ids com verse=0. */
  verse: z.number().int().nonnegative(),
  canonStatus: canonStatusSchema,
  theologicalCategory: z.string().nullable(),
});
export type CanonicalVerse = z.infer<typeof canonicalVerseSchema>;

export const verseTextSchema = z.object({
  canonicalId: canonicalIdSchema,
  translation: z.string().min(1),
  text: z.string().min(1),
  embeddingModel: z.string().nullable(),
  thematicTags: z.array(z.string()),
  culturalContext: z.string().nullable(),
  humanReviewed: z.boolean(),
  reviewedBy: z.string().nullable(),
  authorizedLevels: z.array(accessLevelSchema).min(1),
});
export type VerseText = z.infer<typeof verseTextSchema>;

export const originalWordSchema = z.object({
  canonicalId: canonicalIdSchema,
  position: z.number().int().nonnegative(),
  lexeme: z.string().min(1),
  strongId: z.string().nullable(),
  /** dStrong bruto do STEPBible (letra de desambiguação + tags H9xxx que se perdem no strongId). */
  strongRaw: z.string().nullable(),
  morphology: z.string().nullable(),
});
export type OriginalWord = z.infer<typeof originalWordSchema>;

export const strongsEntrySchema = z.object({
  id: z.string().regex(/^[HG]\d{1,4}$/, "id Strong deve ser H#### ou G####"),
  language: z.enum(["hebrew", "greek"]),
  lemma: z.string().min(1),
  transliteration: z.string().nullable(),
  definition: z.string().min(1),
});
export type StrongsEntry = z.infer<typeof strongsEntrySchema>;

export const edgeSchema = z.object({
  sourceId: canonicalIdSchema,
  targetId: canonicalIdSchema,
  kind: edgeKindSchema,
});
export type Edge = z.infer<typeof edgeSchema>;

/** Entrada do log append-only de curadoria (JSONL é a fonte de verdade). */
export const curationEntrySchema = z.object({
  canonicalId: canonicalIdSchema,
  field: z.string().min(1),
  newValue: z.string(),
  author: z.string().min(1),
  timestamp: z.string().datetime(),
});
export type CurationEntry = z.infer<typeof curationEntrySchema>;

export const reportSchema = z.object({
  id: z.string().min(1),
  canonicalId: canonicalIdSchema,
  field: z.string().min(1),
  kind: z.string().min(1),
  comment: z.string(),
  reportedBy: z.string().min(1),
  timestamp: z.string().datetime(),
  status: z.enum(["open", "triaged", "resolved", "rejected"]),
});
export type Report = z.infer<typeof reportSchema>;

/**
 * Interpretações divergentes são registros separados (ADR-004) e a geração
 * NUNCA as funde — invariante anti-ambiguidade do produto.
 */
export const interpretationSchema = z.object({
  id: z.string().min(1),
  canonicalId: canonicalIdSchema,
  viewLabel: z.string().min(1),
  text: z.string().min(1),
  tradition: z.string().nullable(),
  source: z.string().nullable(),
  humanReviewed: z.boolean(),
  reviewedBy: z.string().nullable(),
});
export type Interpretation = z.infer<typeof interpretationSchema>;
