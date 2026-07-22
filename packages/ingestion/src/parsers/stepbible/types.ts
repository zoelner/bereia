import { z } from "zod";
import { canonicalIdSchema } from "@bereia/core";

/**
 * Tipos e vocabulários fechados do domínio STEPBible (TAHOT + TAGNT, CC BY 4.0).
 * Todo vocabulário é fechado ao levantado em docs/plano-stepbible.md §2: código ou
 * notação fora do que foi observado EXPLODE no parser (determinismo é requisito de
 * produto — uma ref ambígua contaminaria canonical_id silenciosamente).
 */

/**
 * TextType do TAHOT (col 1, após "="): fonte do texto hebraico apontado.
 * Vocabulário fechado ao plano §2.1:
 *   L=Leningrad, Q=Qere, K=Ketiv, R=restaurado, X=reconstruído (LXX).
 */
export const TAHOT_TEXT_TYPES = ["L", "Q", "K", "R", "X"] as const;
export const tahotTextTypeSchema = z.enum(TAHOT_TEXT_TYPES);
export type TahotTextType = z.infer<typeof tahotTextTypeSchema>;

/**
 * Presença de uma palavra numa edição do NT grego (marcada pelo WordType do TAGNT):
 *   "firm"    = letra MAIÚSCULA (presença firme no texto-base)
 *   "variant" = letra minúscula ou entre parênteses (presença como variante)
 */
export const editionPresenceSchema = z.enum(["firm", "variant"]);
export type EditionPresence = z.infer<typeof editionPresenceSchema>;

/**
 * WordType do TAGNT (col 1, após "=") decomposto por edição:
 *   na    = Nestlé-Aland      (letra N/n)
 *   tr    = KJV/Scrivener 1894 = Textus Receptus (letra K/k)
 *   other = outro grego       (letra O/o)
 * null = palavra ausente naquela edição. `raw` preserva o carimbo original (ex.: "N(k)O").
 * A projeção TR (K ∈ wordType) é decisão do parser TAGNT (N4), não deste tipo.
 */
export const tagntWordTypeSchema = z
  .object({
    raw: z.string().min(1),
    na: editionPresenceSchema.nullable(),
    tr: editionPresenceSchema.nullable(),
    other: editionPresenceSchema.nullable(),
  })
  .refine(
    (wt) => wt.na !== null || wt.tr !== null || wt.other !== null,
    "WordType TAGNT sem nenhuma edição presente",
  );
export type TagntWordType = z.infer<typeof tagntWordTypeSchema>;

/**
 * Uma linha TSV do STEPBible = uma palavra ortográfica original = uma TaggedWordRow.
 * Contrato de saída dos parsers TAHOT/TAGNT (plano §3.3); alimenta original_words.
 */
export const taggedWordRowSchema = z.object({
  canonicalId: canonicalIdSchema,
  position: z.number().int().nonnegative(),
  lexeme: z.string().min(1),
  /** Strong lexical normalizado (radical, até 4 díg.); null quando só há tags gramaticais. */
  strongId: z.string().regex(/^[HG]\d{1,4}$/).nullable(),
  /**
   * dStrong bruto preservado (Q2): a letra de desambiguação (H7225G vs H7225) e as
   * tags de prefixo/sufixo H9xxx se perdem no strongId — aqui ficam íntegras.
   */
  strongRaw: z.string().nullable(),
  /** Coluna de morfologia crua (ETCBC/OpenScriptures no TAHOT; grammar no TAGNT). */
  morphology: z.string().nullable(),
  /** Carimbo de edição/texto: TextType (TAHOT) ou WordType bruto (TAGNT). */
  edition: z.string().nullable(),
});
export type TaggedWordRow = z.infer<typeof taggedWordRowSchema>;
