import { z } from "zod";
import type { CanonicalId } from "./canon.js";
import {
  canonicalVerseSchema,
  interpretationSchema,
  originalWordSchema,
  strongsEntrySchema,
  verseTextSchema,
  type CanonicalVerse,
  type Edge,
  type User,
  type VerseText,
} from "./schemas.js";

/**
 * Contrato de retrieval do produto.
 *
 * Invariantes (não são detalhes de implementação):
 * 1. Determinismo: mesmo input → mesmos versículos, sempre. Busca vetorial
 *    EXATA (sem ANN), com tie-break estável: `ORDER BY embedding <=> $q, id`.
 * 2. Hard filter: `canon_status` e `authorized_levels` do usuário são
 *    aplicados ANTES do ranking vetorial, nunca depois.
 *
 * Implementação PgRetrieval chega na Fase 2. Na PoC, `user` é hardcoded.
 */

export interface ThemeSearchOptions {
  translation?: string;
  limit?: number;
}

export interface ThemeSearchResult {
  canonicalId: CanonicalId;
  translation: string;
  text: string;
  /** Distância de cosseno do pgvector — menor é mais próximo. */
  distance: number;
}

export interface CrossReferenceOptions {
  /** Profundidade da cadeia via recursive CTE. Default: 1. */
  maxHops?: number;
}

/**
 * Palavra original (⋈ `strongs` por `strong_id`) usada na exegese.
 *
 * `strong` só existe quando o join resolve — `strongId`/`strongRaw` da
 * `OriginalWord` de base são preservados mesmo quando `strongId` é `null`
 * (dStrong estendido 5-díg./G6xxx-G7xxx, backlog Fase 1). O join NUNCA
 * inventa um Strong ausente; a ausência fica explícita no shape.
 */
export const exegesisOriginalWordSchema = originalWordSchema.extend({
  strong: strongsEntrySchema.optional(),
});
export type ExegesisOriginalWord = z.infer<typeof exegesisOriginalWordSchema>;

/**
 * Shape de saída de `getExegesis` (ADR-010).
 *
 * `interpretations` é o **array cru** de `Interpretation` (ADR-004): o tipo
 * não expõe nenhum campo de resumo/fusão (ex.: `summary`) — a única forma de
 * consumir divergências é iterando as linhas separadas. Fundir é impossível
 * sem violar o contrato (anti-ambiguidade, CLAUDE.md §1).
 */
export const exegesisResultSchema = z.object({
  verse: canonicalVerseSchema,
  texts: z.array(verseTextSchema),
  originalWords: z.array(exegesisOriginalWordSchema),
  interpretations: z.array(interpretationSchema),
});
export type ExegesisResult = z.infer<typeof exegesisResultSchema>;

export interface RetrievalService {
  searchByTheme(query: string, user: User, options?: ThemeSearchOptions): Promise<ThemeSearchResult[]>;
  /**
   * `getVerse` permanece INTOCADO (âncora ADR-008): shape simples
   * `{ verse, texts }`, sem palavras originais nem interpretações — barato
   * para os casos que só precisam do texto.
   *
   * Semântica de `null` vs. `texts: []` (mesma nuance de `getExegesis`
   * abaixo): `null` é reservado a verso INEXISTENTE no cânon autorizado (sem
   * linha em `canonical_verses`, ou `canon_status` fora do MVP); um verso
   * existente cujas `verse_texts` são todas excluídas pelo hard filter de
   * `authorized_levels` do `user` devolve um objeto NÃO-nulo com
   * `texts: []` — não há coluna de controle de acesso por verso, então
   * "nenhum texto autorizado" e "verso inexistente" são estados distintos
   * por construção, nunca colapsados em `null`.
   */
  getVerse(canonicalId: CanonicalId, user: User): Promise<{ verse: CanonicalVerse; texts: VerseText[] } | null>;
  /**
   * Operação NOVA (ADR-010) para o objetivo (2) do produto — exegese de
   * paradoxos com contexto histórico-cultural rígido. Devolve verso, textos,
   * `originalWords` (join com `strongs`, `strongId:null` preservado) e
   * `interpretations` (array cru, nunca fundido — ver `exegesisResultSchema`).
   *
   * Invariantes, iguais às de `searchByTheme`/`getVerse`:
   * - Determinismo: mesmo `canonicalId` → mesmo resultado, sempre;
   * - Hard filter (`canon_status`, `authorized_levels`) aplicado ANTES de
   *   devolver qualquer linha — texto/palavra/interpretação não autorizados
   *   nunca vazam;
   * - `null` é reservado a verso INEXISTENTE no cânon autorizado (sem linha
   *   em `canonical_verses`, ou `canon_status` fora do MVP) — NÃO a "verso
   *   não autorizado" em geral. Um verso existente cujas `verse_texts` são
   *   todas filtradas pelo hard filter de `authorized_levels` devolve um
   *   objeto NÃO-nulo com `texts: []` (idem `originalWords`/`interpretations`
   *   quando aplicável); não há coluna de controle de acesso por verso no
   *   schema atual, então "nenhum texto autorizado" e "verso inexistente"
   *   são estados distintos por construção.
   */
  getExegesis(canonicalId: CanonicalId, user: User): Promise<ExegesisResult | null>;
  getCrossReferences(canonicalId: CanonicalId, user: User, options?: CrossReferenceOptions): Promise<Edge[]>;
}
