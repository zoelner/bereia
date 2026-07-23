/**
 * Exegese de um versículo (N4 do plano da Fase 2, §3.1/§6.1). Implementa a
 * CONSULTA que satisfaz `exegesisResultSchema`/a operação `getExegesis` do
 * port `RetrievalService` (`packages/core/src/retrieval.ts`, ADR-010):
 * verso + `verse_texts` (sob hard filter) + `original_words ⋈ strongs`
 * (join à esquerda, `strongId:null` preservado) + `interpretations` (array
 * cru, NUNCA fundido — ADR-004).
 *
 * Este módulo é a função de baixo nível (recebe a conexão `sql` e as opções
 * de hard filter já resolvidas); a composição com o port `RetrievalService`
 * completo (traduzir `User` → `authorizedLevels`) é responsabilidade do N6
 * (`PgRetrieval`) — aqui não se importa nada de fora de `@bereia/core` e do
 * driver `postgres`.
 *
 * ## Hard filter (CLAUDE.md §5, plano §3.1)
 * - `canon_status`: fixo em `'protestant'` — deuterocanônicos estão FORA do
 *   MVP (CLAUDE.md §2), então `getExegesis` nunca devolve um verso
 *   `deuterocanonical`, independentemente do usuário. Não é uma decisão por
 *   `accessLevels` (o enum `AccessLevel` não modela cânon); é uma restrição
 *   estrutural da Fase 2, reavaliável quando deuterocanônicos entrarem em
 *   escopo.
 * - `authorized_levels`: por linha de `verse_texts`, comparado por overlap
 *   (`&&`) contra `options.authorizedLevels` — só textos com pelo menos um
 *   nível autorizado do usuário aparecem. `original_words`/`interpretations`
 *   não têm coluna de controle de acesso no schema atual (`db/schema.ts`);
 *   uma vez que o verso passa no hard filter de `canon_status`, todas as suas
 *   palavras/interpretações são devolvidas — o filtro efetivo delas é
 *   "pertence a um verso autorizado", não um filtro próprio por linha.
 *
 * ## Determinismo
 * Toda ordenação é explícita na SQL (nunca depende de ordem física de disco):
 * `verse_texts` por `translation` (chave única dentro do verso, parte da PK
 * composta); `original_words` por `position` (ordem lexical original);
 * `interpretations` por `id` (chave estável, monotônica por inserção — ordem
 * documentada, não arbitrária).
 */

import postgres from "postgres";
import {
  canonicalIdSchema,
  exegesisResultSchema,
  type AccessLevel,
  type CanonicalId,
  type ExegesisResult,
} from "@bereia/core";

/** Hard filter que `getExegesis` aplica em `verse_texts` (§3.1/§5 do plano). */
export interface ExegesisOptions {
  /** Níveis de acesso do usuário — overlap contra `verse_texts.authorized_levels`. */
  authorizedLevels: readonly AccessLevel[];
}

// --- shape das linhas cruas retornadas pelo driver (snake_case do Postgres) -

interface CanonicalVerseRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  canon_status: string;
  theological_category: string | null;
}

interface VerseTextRow {
  canonical_id: string;
  translation: string;
  text: string;
  embedding_model: string | null;
  thematic_tags: string[];
  cultural_context: string | null;
  human_reviewed: boolean;
  reviewed_by: string | null;
  authorized_levels: string[];
}

interface OriginalWordRow {
  canonical_id: string;
  position: number;
  lexeme: string;
  strong_id: string | null;
  strong_raw: string | null;
  morphology: string | null;
  edition: string | null;
  // Colunas de `strongs` via LEFT JOIN — todas `null` quando o join não resolve.
  strong_language: string | null;
  strong_lemma: string | null;
  strong_transliteration: string | null;
  strong_definition: string | null;
}

interface InterpretationRow {
  id: string; // `id::text` — a PK real é `serial` (integer), mas o contrato Zod usa string (ADR-004)
  canonical_id: string;
  view_label: string;
  text: string;
  tradition: string | null;
  source: string | null;
  human_reviewed: boolean;
  reviewed_by: string | null;
}

/**
 * Busca a exegese completa de `canonicalId` sob o hard filter de
 * `options.authorizedLevels`. Verso inexistente (ou fora do hard filter de
 * `canon_status`, ver cabeçalho do módulo) → `null`, nunca erro — não é uma
 * condição excepcional, é o contrato normal de "não encontrado".
 */
export async function getExegesis(
  sql: postgres.Sql,
  canonicalId: CanonicalId,
  options: ExegesisOptions,
): Promise<ExegesisResult | null> {
  canonicalIdSchema.parse(canonicalId);
  if (options.authorizedLevels.length === 0) {
    throw new Error(
      "getExegesis: options.authorizedLevels vazio — hard filter sem nenhum nível autorizado não devolveria " +
        "nenhum texto por definição; passe ao menos um nível (bug de chamada, não deveria acontecer)",
    );
  }

  const verseRows = await sql<CanonicalVerseRow[]>`
    SELECT id, book, chapter, verse, canon_status, theological_category
    FROM canonical_verses
    WHERE id = ${canonicalId}
      AND canon_status = 'protestant'
  `;
  const verseRow = verseRows[0];
  if (verseRow === undefined) {
    return null;
  }

  const authorizedLevels = sql.array([...options.authorizedLevels]);

  const [textRows, wordRows, interpretationRows] = await Promise.all([
    sql<VerseTextRow[]>`
      SELECT
        canonical_id, translation, text, embedding_model, thematic_tags,
        cultural_context, human_reviewed, reviewed_by, authorized_levels
      FROM verse_texts
      WHERE canonical_id = ${canonicalId}
        AND authorized_levels && ${authorizedLevels}
      ORDER BY translation
    `,
    sql<OriginalWordRow[]>`
      SELECT
        ow.canonical_id, ow.position, ow.lexeme, ow.strong_id, ow.strong_raw,
        ow.morphology, ow.edition,
        s.language AS strong_language, s.lemma AS strong_lemma,
        s.transliteration AS strong_transliteration, s.definition AS strong_definition
      FROM original_words ow
      LEFT JOIN strongs s ON s.id = ow.strong_id
      WHERE ow.canonical_id = ${canonicalId}
      ORDER BY ow.position
    `,
    sql<InterpretationRow[]>`
      SELECT id::text AS id, canonical_id, view_label, text, tradition, source, human_reviewed, reviewed_by
      FROM interpretations
      WHERE canonical_id = ${canonicalId}
      ORDER BY id
    `,
  ]);

  const result: ExegesisResult = {
    verse: {
      id: verseRow.id as CanonicalId,
      book: verseRow.book as ExegesisResult["verse"]["book"],
      chapter: verseRow.chapter,
      verse: verseRow.verse,
      canonStatus: verseRow.canon_status as ExegesisResult["verse"]["canonStatus"],
      theologicalCategory: verseRow.theological_category,
    },
    texts: textRows.map((row) => ({
      canonicalId: row.canonical_id as CanonicalId,
      translation: row.translation,
      text: row.text,
      embeddingModel: row.embedding_model,
      thematicTags: row.thematic_tags,
      culturalContext: row.cultural_context,
      humanReviewed: row.human_reviewed,
      reviewedBy: row.reviewed_by,
      authorizedLevels: row.authorized_levels as AccessLevel[],
    })),
    originalWords: wordRows.map((row) => ({
      canonicalId: row.canonical_id as CanonicalId,
      position: row.position,
      lexeme: row.lexeme,
      strongId: row.strong_id,
      strongRaw: row.strong_raw,
      morphology: row.morphology,
      edition: row.edition,
      // `strong` só existe quando o LEFT JOIN resolveu (todas as colunas presentes) —
      // o join NUNCA inventa um Strong ausente (ver cabeçalho do módulo/ADR-010).
      ...(row.strong_language !== null &&
      row.strong_lemma !== null &&
      row.strong_definition !== null
        ? {
            strong: {
              id: row.strong_id as string,
              language: row.strong_language as "hebrew" | "greek",
              lemma: row.strong_lemma,
              transliteration: row.strong_transliteration,
              definition: row.strong_definition,
            },
          }
        : {}),
    })),
    interpretations: interpretationRows.map((row) => ({
      id: row.id,
      canonicalId: row.canonical_id as CanonicalId,
      viewLabel: row.view_label,
      text: row.text,
      tradition: row.tradition,
      source: row.source,
      humanReviewed: row.human_reviewed,
      reviewedBy: row.reviewed_by,
    })),
  };

  // Zod na fronteira de saída — explode cedo se a SQL divergir do contrato.
  return exegesisResultSchema.parse(result);
}
