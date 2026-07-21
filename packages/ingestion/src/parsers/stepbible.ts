import { z } from "zod";
import { canonicalIdSchema } from "@bereia/core";
import { NotImplementedError } from "../errors.js";

/**
 * Parsers dos TSV do STEPBible (CC BY 4.0):
 * - TAHOT: AT hebraico tageado (Strong + morfologia)
 * - TAGNT: NT grego (TR e NA27/28 marcados por edição)
 */

export const taggedWordRowSchema = z.object({
  canonicalId: canonicalIdSchema,
  position: z.number().int().nonnegative(),
  lexeme: z.string().min(1),
  strongId: z.string().regex(/^[HG]\d{1,4}$/).nullable(),
  morphology: z.string().nullable(),
  /** TAGNT marca a edição (TR, NA27/28); TAHOT não usa. */
  edition: z.string().nullable(),
});
export type TaggedWordRow = z.infer<typeof taggedWordRowSchema>;

export function parseTahot(_tsv: string): TaggedWordRow[] {
  throw new NotImplementedError("parser TAHOT");
}

export function parseTagnt(_tsv: string): TaggedWordRow[] {
  throw new NotImplementedError("parser TAGNT");
}
