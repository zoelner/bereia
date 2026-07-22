-- Migration inicial: extensão pgvector + projeção relacional da fonte de verdade.
-- O banco é descartável; o JSONL em data/canonical/ manda.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE canon_status AS ENUM ('protestant', 'deuterocanonical');
CREATE TYPE edge_kind AS ENUM ('tsk', 'thematic', 'manual');
CREATE TYPE report_status AS ENUM ('open', 'triaged', 'resolved', 'rejected');

CREATE TABLE canonical_verses (
  id text PRIMARY KEY,
  book text NOT NULL,
  chapter integer NOT NULL,
  verse integer NOT NULL,
  canon_status canon_status NOT NULL DEFAULT 'protestant',
  theological_category text
);

CREATE TABLE verse_texts (
  canonical_id text NOT NULL REFERENCES canonical_verses(id),
  translation text NOT NULL,
  text text NOT NULL,
  embedding vector(1024),
  embedding_model text,
  thematic_tags text[] NOT NULL DEFAULT '{}',
  cultural_context text,
  human_reviewed boolean NOT NULL DEFAULT false,
  reviewed_by text,
  authorized_levels text[] NOT NULL DEFAULT '{public}',
  PRIMARY KEY (canonical_id, translation)
);

-- Espaço de embeddings por perícope (ADR-003) — populado quando o eval justificar
CREATE TABLE passage_texts (
  passage_id text PRIMARY KEY,
  book text NOT NULL,
  chapter integer NOT NULL,
  verse_start integer NOT NULL,
  verse_end integer NOT NULL,
  translation text NOT NULL,
  text text NOT NULL,
  embedding vector(1024),
  embedding_model text
);

CREATE TABLE original_words (
  canonical_id text NOT NULL REFERENCES canonical_verses(id),
  position integer NOT NULL,
  lexeme text NOT NULL,
  strong_id text,
  strong_raw text, -- dStrong bruto do STEPBible (Q2 do plano)
  morphology text,
  PRIMARY KEY (canonical_id, position)
);

CREATE TABLE strongs (
  id text PRIMARY KEY,
  language text NOT NULL,
  lemma text NOT NULL,
  transliteration text,
  definition text NOT NULL
);

CREATE TABLE edges (
  source_id text NOT NULL REFERENCES canonical_verses(id),
  target_id text NOT NULL REFERENCES canonical_verses(id),
  kind edge_kind NOT NULL,
  PRIMARY KEY (source_id, target_id, kind)
);

CREATE TABLE curation_log (
  id serial PRIMARY KEY,
  canonical_id text NOT NULL REFERENCES canonical_verses(id),
  field text NOT NULL,
  new_value text NOT NULL,
  author text NOT NULL,
  "timestamp" timestamptz NOT NULL
);

CREATE TABLE reports (
  id serial PRIMARY KEY,
  canonical_id text NOT NULL REFERENCES canonical_verses(id),
  field text NOT NULL,
  kind text NOT NULL,
  comment text NOT NULL,
  reported_by text NOT NULL,
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  status report_status NOT NULL DEFAULT 'open'
);

-- Interpretações divergentes: linhas separadas, nunca fundidas (ADR-004)
CREATE TABLE interpretations (
  id serial PRIMARY KEY,
  canonical_id text NOT NULL REFERENCES canonical_verses(id),
  view_label text NOT NULL,
  text text NOT NULL,
  tradition text,
  source text,
  human_reviewed boolean NOT NULL DEFAULT false,
  reviewed_by text
);
