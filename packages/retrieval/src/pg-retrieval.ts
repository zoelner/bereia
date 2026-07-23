/**
 * Composição `PgRetrieval` (N6 do plano da Fase 2, §6.1). Ponto único de
 * fiação: implementa o port `RetrievalService` do core
 * (`packages/core/src/retrieval.ts`) delegando cada operação ao módulo já
 * pronto — `searchByTheme` (N3), `getExegesis` (N4), `getCrossReferences`
 * (N5) — mais o `QueryEmbedder` (N2). Nenhuma lógica de negócio nova aqui,
 * exceto `getVerse`: o port exige a operação, mas nenhum nó anterior a
 * implementou (N4 entrega `getExegesis`, mais rico); `getVerse` é uma
 * consulta simples e deliberadamente mais barata (verso + `verse_texts` sob
 * hard filter, sem `original_words`/`interpretations`), no mesmo padrão de
 * SQL dos demais módulos do pacote.
 *
 * ## Injeção de dependências — sem ciclo de vida próprio
 * `PgRetrieval` é construído com `{ sql, embedder }` já prontos — nunca abre
 * conexão nem instancia o `QueryEmbedder` sozinho. Quem instancia
 * `PgRetrieval` (app, harness de eval, teste) decide o ciclo de vida da
 * conexão `postgres.Sql` (abrir/fechar) e do `QueryEmbedder` (URL do
 * sidecar). Isso evita que este adapter esconda I/O de setup/teardown atrás
 * de um construtor "mágico" — coerente com o restante do pacote (todo
 * módulo N3/N4/N5 recebe `sql` como parâmetro, nunca cria).
 *
 * ## `getVerse` — semântica de `null` vs. `texts: []`
 * Espelha exatamente `getExegesis` (ver `exegesis.ts` e o docstring do port
 * no core, retocado por este nó): `null` é reservado a verso inexistente no
 * cânon autorizado (sem linha em `canonical_verses`, ou `canon_status` fora
 * do MVP); um verso existente cujas `verse_texts` são todas excluídas pelo
 * hard filter de `authorized_levels` devolve um objeto não-nulo com
 * `texts: []` — "nenhum texto autorizado" e "verso inexistente" são estados
 * distintos por construção (não há coluna de controle de acesso por verso).
 *
 * ## `fuseCrossReferences` — fusão RRF com o grafo, OPT-IN (Estágio 2 do
 * plano de enriquecimento do retrieval)
 * Flag opcional, default `false` (comportamento IDÊNTICO ao anterior a este
 * nó — nada muda para quem não passa a opção). Quando `true`,
 * `PgRetrieval.searchByTheme` delega a `searchByThemeFused`
 * (`search-theme-fused.ts`) em vez de `searchByTheme` puro — funde o ranking
 * denso com uma expansão de 1 hop do grafo de cross-references via RRF
 * determinístico. O port `RetrievalService` fica INTOCADO (a assinatura de
 * `searchByTheme` não muda) — a fusão é um detalhe de composição interno do
 * adapter, nunca do contrato.
 */

import type postgres from "postgres";
import { z } from "zod";
import {
  canonicalIdSchema,
  canonicalVerseSchema,
  verseTextSchema,
  type AccessLevel,
  type CanonicalId,
  type CanonicalVerse,
  type CrossReferenceOptions,
  type Edge,
  type ExegesisResult,
  type RetrievalService,
  type ThemeSearchOptions,
  type ThemeSearchResult,
  type User,
  type VerseText,
} from "@bereia/core";
import { getCrossReferences } from "./cross-references.js";
import type { QueryEmbedder } from "./embedder.js";
import { getExegesis } from "./exegesis.js";
import { searchByThemeFused } from "./search-theme-fused.js";
import { searchByTheme } from "./search-theme.js";

export interface PgRetrievalOptions {
  /** Conexão `postgres` já aberta — `PgRetrieval` não cria nem fecha. */
  sql: postgres.Sql;
  /** Cliente de embedding de query (trava de revisão ADR-005 já embutida). */
  embedder: QueryEmbedder;
  /**
   * OPT-IN da fusão RRF com o grafo de cross-references (ver docstring do
   * módulo). Default `false` — comportamento idêntico ao denso puro.
   */
  fuseCrossReferences?: boolean;
}

// --- shape das linhas cruas de `getVerse` (mesmo contorno de exegesis.ts) --

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

const getVerseResultSchema = z.object({
  verse: canonicalVerseSchema,
  texts: z.array(verseTextSchema),
});

/**
 * Literal de array do Postgres (`text[]`) — mesmo contorno de
 * `search-theme.ts`/`cross-references.ts` (nunca `sql.array`, ver docstring
 * desses módulos para o motivo da corrida de tipo lazy). `exegesis.ts` ainda
 * usa `sql.array` — consolidação dos helpers é backlog (OQ-7/N3).
 */
function formatTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

/** Adapter de `RetrievalService` sobre Postgres+pgvector (ADR-007/ADR-010). */
export class PgRetrieval implements RetrievalService {
  private readonly sql: postgres.Sql;
  private readonly embedder: QueryEmbedder;
  private readonly fuseCrossReferences: boolean;

  constructor(options: PgRetrievalOptions) {
    this.sql = options.sql;
    this.embedder = options.embedder;
    this.fuseCrossReferences = options.fuseCrossReferences ?? false;
  }

  searchByTheme(query: string, user: User, options?: ThemeSearchOptions): Promise<ThemeSearchResult[]> {
    const search = this.fuseCrossReferences ? searchByThemeFused : searchByTheme;
    return search(this.sql, this.embedder, query, { ...options, user });
  }

  async getVerse(canonicalId: CanonicalId, user: User): Promise<{ verse: CanonicalVerse; texts: VerseText[] } | null> {
    const parsedCanonicalId = canonicalIdSchema.parse(canonicalId);
    if (user.accessLevels.length === 0) {
      throw new Error(
        "getVerse: user.accessLevels vazio — hard filter sem nenhum nível autorizado não devolveria " +
          "nenhum texto por definição; passe ao menos um nível (bug de chamada, não deveria acontecer)",
      );
    }

    const verseRows = await this.sql<CanonicalVerseRow[]>`
      SELECT id, book, chapter, verse, canon_status, theological_category
      FROM canonical_verses
      WHERE id = ${parsedCanonicalId}
        AND canon_status = 'protestant'
    `;
    const verseRow = verseRows[0];
    if (verseRow === undefined) {
      return null;
    }

    const accessLevelsLiteral = formatTextArrayLiteral([...user.accessLevels]);
    const textRows = await this.sql<VerseTextRow[]>`
      SELECT
        canonical_id, translation, text, embedding_model, thematic_tags,
        cultural_context, human_reviewed, reviewed_by, authorized_levels
      FROM verse_texts
      WHERE canonical_id = ${parsedCanonicalId}
        AND authorized_levels && ${accessLevelsLiteral}::text[]
      ORDER BY translation
    `;

    const result = {
      verse: {
        id: verseRow.id as CanonicalId,
        book: verseRow.book as CanonicalVerse["book"],
        chapter: verseRow.chapter,
        verse: verseRow.verse,
        canonStatus: verseRow.canon_status as CanonicalVerse["canonStatus"],
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
    };

    // Zod na fronteira de saída — explode cedo se a SQL divergir do contrato.
    return getVerseResultSchema.parse(result);
  }

  getExegesis(canonicalId: CanonicalId, user: User): Promise<ExegesisResult | null> {
    return getExegesis(this.sql, canonicalId, { authorizedLevels: user.accessLevels });
  }

  getCrossReferences(canonicalId: CanonicalId, user: User, options?: CrossReferenceOptions): Promise<Edge[]> {
    return getCrossReferences(this.sql, canonicalId, { ...options, user });
  }
}
