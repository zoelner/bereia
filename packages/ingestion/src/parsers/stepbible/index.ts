/**
 * Barrel do domínio STEPBible (N1-N5): reexporta os ports públicos e tipos de
 * types.ts (contrato TaggedWordRow + vocabulários fechados), refs.ts (parser da
 * coluna de referência), strongs.ts (normalização de dStrong) e os parsers
 * completos tahot.ts/tagnt.ts (incluindo a agregação hebraica que alimenta o
 * gate de versificação, N5). Sem colisão de nomes entre os módulos — conferido
 * na integração (N6).
 */
export * from "./types.js";
export * from "./refs.js";
export * from "./strongs.js";
export * from "./tahot.js";
export * from "./tagnt.js";
