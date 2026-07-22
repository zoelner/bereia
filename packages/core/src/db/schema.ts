import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Projeção relacional da fonte de verdade (JSONL em data/canonical/).
 * O banco é descartável e reconstruível; o JSONL manda.
 */

export const canonStatusEnum = pgEnum("canon_status", ["protestant", "deuterocanonical"]);
export const edgeKindEnum = pgEnum("edge_kind", ["tsk", "thematic", "manual"]);
export const reportStatusEnum = pgEnum("report_status", ["open", "triaged", "resolved", "rejected"]);

export const canonicalVerses = pgTable("canonical_verses", {
  id: text("id").primaryKey(), // BOOK_CHAPTER_VERSE, códigos USFM (ADR-001)
  book: text("book").notNull(),
  chapter: integer("chapter").notNull(),
  verse: integer("verse").notNull(),
  canonStatus: canonStatusEnum("canon_status").notNull().default("protestant"),
  theologicalCategory: text("theological_category"),
});

export const verseTexts = pgTable(
  "verse_texts",
  {
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => canonicalVerses.id),
    translation: text("translation").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    embeddingModel: text("embedding_model"),
    thematicTags: text("thematic_tags").array().notNull().default([]),
    culturalContext: text("cultural_context"),
    humanReviewed: boolean("human_reviewed").notNull().default(false),
    reviewedBy: text("reviewed_by"),
    authorizedLevels: text("authorized_levels").array().notNull().default(["public"]),
  },
  (table) => [primaryKey({ columns: [table.canonicalId, table.translation] })],
);

/** Espaço de embeddings por perícope (ADR-003) — vazio até o eval da Fase 2 justificar. */
export const passageTexts = pgTable("passage_texts", {
  passageId: text("passage_id").primaryKey(),
  book: text("book").notNull(),
  chapter: integer("chapter").notNull(),
  verseStart: integer("verse_start").notNull(),
  verseEnd: integer("verse_end").notNull(),
  translation: text("translation").notNull(),
  text: text("text").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),
  embeddingModel: text("embedding_model"),
});

export const originalWords = pgTable(
  "original_words",
  {
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => canonicalVerses.id),
    position: integer("position").notNull(),
    lexeme: text("lexeme").notNull(),
    strongId: text("strong_id"),
    strongRaw: text("strong_raw"), // dStrong bruto do STEPBible (Q2 do plano)
    morphology: text("morphology"),
    edition: text("edition"), // carimbo TR/NA/variante por palavra (TAGNT); null p/ TAHOT (OQ-6)
  },
  (table) => [primaryKey({ columns: [table.canonicalId, table.position] })],
);

export const strongs = pgTable("strongs", {
  id: text("id").primaryKey(), // H#### | G####
  language: text("language").notNull(), // hebrew | greek
  lemma: text("lemma").notNull(),
  transliteration: text("transliteration"),
  definition: text("definition").notNull(),
});

export const edges = pgTable(
  "edges",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => canonicalVerses.id),
    targetId: text("target_id")
      .notNull()
      .references(() => canonicalVerses.id),
    kind: edgeKindEnum("kind").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.targetId, table.kind] })],
);

/** Projeção do log append-only de curadoria (curation.jsonl é a fonte de verdade). */
export const curationLog = pgTable("curation_log", {
  id: serial("id").primaryKey(),
  canonicalId: text("canonical_id")
    .notNull()
    .references(() => canonicalVerses.id),
  field: text("field").notNull(),
  newValue: text("new_value").notNull(),
  author: text("author").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  canonicalId: text("canonical_id")
    .notNull()
    .references(() => canonicalVerses.id),
  field: text("field").notNull(),
  kind: text("kind").notNull(),
  comment: text("comment").notNull(),
  reportedBy: text("reported_by").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  status: reportStatusEnum("status").notNull().default("open"),
});

/** Interpretações divergentes ficam em linhas separadas e NUNCA são fundidas (ADR-004). */
export const interpretations = pgTable("interpretations", {
  id: serial("id").primaryKey(),
  canonicalId: text("canonical_id")
    .notNull()
    .references(() => canonicalVerses.id),
  viewLabel: text("view_label").notNull(),
  text: text("text").notNull(),
  tradition: text("tradition"),
  source: text("source"),
  humanReviewed: boolean("human_reviewed").notNull().default(false),
  reviewedBy: text("reviewed_by"),
});
