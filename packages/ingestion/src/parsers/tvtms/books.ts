import type { UsfmBook } from "@bereia/core";

/**
 * Tabela versionada de códigos de livro TVTMS → USFM (ADR-001/ADR-002).
 *
 * O TVTMS usa os códigos USFM em title-case ("Jhn", "Jol", "Nam"), mas a
 * correspondência é declarada explicitamente — nunca derivada por transformação
 * de string — para que qualquer mudança de vocabulário no upstream exploda
 * aqui, e não contamine canonical_id silenciosamente.
 */
export const TVTMS_TO_USFM: Readonly<Record<string, UsfmBook>> = {
  Gen: "GEN", Exo: "EXO", Lev: "LEV", Num: "NUM", Deu: "DEU",
  Jos: "JOS", Jdg: "JDG", Rut: "RUT", "1Sa": "1SA", "2Sa": "2SA",
  "1Ki": "1KI", "2Ki": "2KI", "1Ch": "1CH", "2Ch": "2CH", Ezr: "EZR",
  Neh: "NEH", Est: "EST", Job: "JOB", Psa: "PSA", Pro: "PRO",
  Ecc: "ECC", Sng: "SNG", Isa: "ISA", Jer: "JER", Lam: "LAM",
  Ezk: "EZK", Dan: "DAN", Hos: "HOS", Jol: "JOL", Amo: "AMO",
  Oba: "OBA", Jon: "JON", Mic: "MIC", Nam: "NAM", Hab: "HAB",
  Zep: "ZEP", Hag: "HAG", Zec: "ZEC", Mal: "MAL",
  Mat: "MAT", Mrk: "MRK", Luk: "LUK", Jhn: "JHN", Act: "ACT",
  Rom: "ROM", "1Co": "1CO", "2Co": "2CO", Gal: "GAL", Eph: "EPH",
  Php: "PHP", Col: "COL", "1Th": "1TH", "2Th": "2TH", "1Ti": "1TI",
  "2Ti": "2TI", Tit: "TIT", Phm: "PHM", Heb: "HEB", Jas: "JAS",
  "1Pe": "1PE", "2Pe": "2PE", "1Jn": "1JN", "2Jn": "2JN", "3Jn": "3JN",
  Jud: "JUD", Rev: "REV",
};

/** Inverso (USFM → TVTMS), para o mapper traduzir consultas do domínio. */
export const USFM_TO_TVTMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TVTMS_TO_USFM).map(([tvtms, usfm]) => [usfm, tvtms]),
);

/**
 * Códigos deuterocanônicos/apócrifos presentes no TVTMS (observados no dado).
 * Reconhecidos — as linhas que os usam são puladas com estatística, não erro —
 * mas fora do cânon de 66 livros do MVP (canon_status cobre o futuro).
 */
export const NON_CANONICAL_TVTMS_BOOKS: ReadonlySet<string> = new Set([
  "1Es", "2Es", "3Es", "4Es",
  "1Ma", "2Ma", "3Ma", "4Ma",
  "Ade", "Bar", "Bel", "Esg", "Jdt", "Lje", "LJe",
  "Man", "Oda", "Ps2", "Sir", "Sus", "Tob", "Wis",
]);

export function isCanonicalTvtmsBook(code: string): boolean {
  return code in TVTMS_TO_USFM;
}

/**
 * Converte código TVTMS → USFM.
 * Retorna null para deuterocanônico conhecido; explode para código desconhecido
 * (vocabulário fechado — determinismo é requisito de produto).
 */
export function tvtmsBookToUsfm(code: string): UsfmBook | null {
  const usfm = TVTMS_TO_USFM[code];
  if (usfm) return usfm;
  if (NON_CANONICAL_TVTMS_BOOKS.has(code)) return null;
  throw new Error(`código de livro TVTMS desconhecido: "${code}"`);
}
