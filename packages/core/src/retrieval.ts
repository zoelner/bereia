import type { CanonicalId } from "./canon.js";
import type { CanonicalVerse, Edge, User, VerseText } from "./schemas.js";

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

export interface RetrievalService {
  searchByTheme(query: string, user: User, options?: ThemeSearchOptions): Promise<ThemeSearchResult[]>;
  getVerse(canonicalId: CanonicalId, user: User): Promise<{ verse: CanonicalVerse; texts: VerseText[] } | null>;
  getCrossReferences(canonicalId: CanonicalId, user: User, options?: CrossReferenceOptions): Promise<Edge[]>;
}
