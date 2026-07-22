import { z } from "zod";
import { canonicalIdSchema } from "@bereia/core";

/**
 * Tipos e vocabulários fechados do domínio STEPBible (TAHOT + TAGNT, CC BY 4.0).
 * O vocabulário é fechado ao levantado nas 6 fontes reais pinadas (manifest sha256):
 * código ou notação fora do observado EXPLODE no parser (determinismo é requisito de
 * produto — uma ref/carimbo ambíguo contaminaria canonical_id silenciosamente).
 */

/**
 * Base do TextType do TAHOT (col 1, após "="): a(s) letra(s) MAIÚSCULA(S) antes de um
 * marcador parentético opcional. Vocabulário levantado nos 4 TAHOT reais (305.652 linhas):
 *   L=Leningrad e suas combinações de testemunhos (LA, LB, LH, LAH, LAB, LBH),
 *   Q=Qere, X=reconstruído (LXX), R=restaurado.
 * (Os "K"/"Q" puros do plano NÃO ocorrem no dado; o Ketiv aparece como marcador de Qere —
 * ex.: Q(K), Q(k) — conforme a decisão Q4: variantes carregadas COM carimbo.)
 */
export const TAHOT_TEXT_BASES = ["L", "LA", "LB", "LH", "LAH", "LAB", "LBH", "Q", "X", "R"] as const;
export const tahotTextBaseSchema = z.enum(TAHOT_TEXT_BASES);
export type TahotTextBase = z.infer<typeof tahotTextBaseSchema>;

/**
 * TextType do TAHOT decomposto: base fechada + marcador parentético cru (Ketiv, letras de
 * testemunho, etc.). `raw` preserva o campo inteiro; `marker` é retido sem enum fechado
 * porque o conteúdo é aberto no upstream (K/k, abh, a+C, S, P, F, …) — a base é o que discrimina.
 */
export const tahotTextTypeSchema = z.object({
  raw: z.string().min(1),
  base: tahotTextBaseSchema,
  marker: z.string().nullable(),
});
export type TahotTextType = z.infer<typeof tahotTextTypeSchema>;

/**
 * Presença de uma palavra numa edição do NT grego (carimbo por letra no WordType do TAGNT),
 * em DOIS eixos ortogonais preservados sem perda (evita re-parse caro no futuro):
 *   variant   = letra minúscula → leitura variante (vs. MAIÚSCULA = texto-base)
 *   bracketed = letra entre parênteses → presença duvidosa/entre colchetes naquela edição
 * Assim N(K)O e N(k)O ficam distintos: ambos bracketed, mas só o 2º é variant.
 */
export const editionPresenceSchema = z.object({
  variant: z.boolean(),
  bracketed: z.boolean(),
});
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
