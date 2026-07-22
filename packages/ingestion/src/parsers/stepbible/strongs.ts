/**
 * Normalização do dStrong bruto do STEPBible (TAHOT/TAGNT) para o `strong_id`
 * lexical simples do core (`/^[HG]\d{1,4}$/`, `strongsEntrySchema`).
 *
 * Formato real levantado (docs/plano-stepbible.md §2, §3.2):
 * - TAHOT (col 5): combina, separados por "/", tags gramaticais de
 *   prefixo/sufixo/pontuação (`H9xxx`, sem componente lexical) com o
 *   radical — que vem entre chaves quando há mais de um segmento
 *   (`H9003/{H7225G}`) ou solto quando a palavra não tem prefixo/sufixo
 *   (`H0430G`, `{H0853}`).
 * - TAGNT (col 4, antes do "="): sempre um único segmento limpo (`G0976`);
 *   o dado real levantado não mostrou tags `G9xxx`, mas o normalizador
 *   trata o caso simetricamente por segurança de vocabulário (ADR-008).
 * - Ambos podem ter uma letra de desambiguação BDB no fim (`H7225G`); ela é
 *   descartada ao normalizar — perda consciente (plano §3.2, Q2): o
 *   `strong_id` aponta o léxico openscriptures (4 dígitos), a string
 *   dStrong bruta é preservada por quem chama (`original_words`/`morphology`
 *   ou campo cru futuro — fora do escopo deste normalizador).
 */

export type StrongLanguage = "hebrew" | "greek";

/**
 * Resultado tipado da classificação do dStrong — NUNCA um `null` opaco: uma
 * tag puramente gramatical (`H9xxx`/`G9xxx`, sem radical lexical) é
 * classificada como `"grammar"` explicitamente, distinta de qualquer outro
 * caminho (que sempre explode). Ver `normalizeStrong` para a assinatura
 * simples (`string | null`) usada pelos parsers TAHOT/TAGNT.
 */
export type StrongClassification =
  | { kind: "lexical"; strongId: string }
  | { kind: "grammar"; strongId: null };

const SEGMENT_RE = /^([HG])(\d{4})([A-Z]?)$/;

const LANGUAGE_LETTER: Record<StrongLanguage, "H" | "G"> = {
  hebrew: "H",
  greek: "G",
};

export class DStrongFormatError extends Error {
  constructor(dStrong: string, detail: string) {
    super(`dStrong "${dStrong}" fora do vocabulário fechado: ${detail}`);
    this.name = "DStrongFormatError";
  }
}

/**
 * Classifica um dStrong bruto (col 5 do TAHOT / col 4 do TAGNT, já isolado
 * do resto da linha) segundo as regras do plano §3.2:
 *
 * 1. Segmentos separados por "/" (prefixo(s) + radical + sufixo(s)).
 * 2. O radical pode vir entre chaves `{...}`; chaves são só delimitador,
 *    removidas antes de validar.
 * 3. Segmento cujos 4 dígitos caem em 9000-9999 é tag gramatical (prefixo,
 *    sufixo, pontuação) — sem componente lexical.
 * 4. Segmento restante (< 9000) é o radical: mantém letra + 4 dígitos,
 *    descarta a letra de desambiguação BDB (`H7225G` → `H7225`).
 * 5. Espera-se exatamente um segmento lexical: nenhum → `{kind:"grammar"}`;
 *    mais de um → explode (vocabulário não previu palavra multi-radical).
 *
 * Explode (não retorna) em qualquer segmento fora do padrão
 * `[HG]\d{4}[Letra?]` (bruto ou entre chaves) ou cujo prefixo de idioma não
 * bate com `lang` — vocabulário fechado, erro cedo e claro (ADR-008).
 */
export function classifyStrong(dStrong: string, lang: StrongLanguage): StrongClassification {
  const expectedLetter = LANGUAGE_LETTER[lang];
  const segments = dStrong.split("/");
  if (dStrong.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new DStrongFormatError(dStrong, "segmento vazio");
  }

  const lexical: string[] = [];
  for (const raw of segments) {
    const braced = raw.startsWith("{") && raw.endsWith("}");
    const bare = braced ? raw.slice(1, -1) : raw;
    if (braced && (bare.includes("{") || bare.includes("}"))) {
      throw new DStrongFormatError(dStrong, `segmento "${raw}" com chaves malformadas`);
    }

    const match = SEGMENT_RE.exec(bare);
    if (!match) {
      throw new DStrongFormatError(
        dStrong,
        `segmento "${raw}" não casa com [HG]dddd[Letra] (bruto ou entre chaves)`,
      );
    }
    const letter = match[1] as string;
    const digits = match[2] as string;
    if (letter !== expectedLetter) {
      throw new DStrongFormatError(
        dStrong,
        `segmento "${raw}" tem prefixo "${letter}", esperado "${expectedLetter}" para idioma "${lang}"`,
      );
    }

    const isGrammarTag = digits.startsWith("9");
    if (!isGrammarTag) lexical.push(`${letter}${digits}`);
  }

  if (lexical.length === 0) return { kind: "grammar", strongId: null };
  if (lexical.length > 1) {
    throw new DStrongFormatError(
      dStrong,
      `múltiplos segmentos lexicais encontrados (${lexical.join(", ")}) — palavra multi-radical não prevista`,
    );
  }
  return { kind: "lexical", strongId: lexical[0] as string };
}

/**
 * Normaliza um dStrong bruto para o `strong_id` canônico do core
 * (`/^[HG]\d{1,4}$/`, `strongsEntrySchema`) — assinatura do plano §3.2,
 * usada pelos parsers TAHOT/TAGNT (N3/N4).
 *
 * `null` tem UM único significado: o dStrong é tag gramatical pura
 * (`H9xxx`/`G9xxx`, sem radical lexical) — nunca "erro" ou "desconhecido"
 * (esses casos sempre explodem). Para inspecionar essa classificação de
 * forma tipada e explícita (sem colapsar em `null`), use `classifyStrong`.
 */
export function normalizeStrong(dStrong: string, lang: StrongLanguage): string | null {
  return classifyStrong(dStrong, lang).strongId;
}
