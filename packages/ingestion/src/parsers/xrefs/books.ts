import type { UsfmBook } from "@bereia/core";

/**
 * Tabela versionada de códigos de livro OpenBible (notação SBL/OSIS) → USFM
 * (ADR-001). Enumerada EXPLICITAMENTE a partir dos 66 tokens realmente
 * presentes em `data/sources/openbible-xrefs/cross_references.txt` (fonte
 * pinada, sha256 do zip `9beb9c…` no manifest) — nunca derivada por
 * transformação de string.
 *
 * A notação do OpenBible difere tanto do USFM quanto do TVTMS: usa `Gen`,
 * `Ps`, `John`, `Exod`, `1Chr`, `Song`, `Joel`, `Obad`, `Phlm`, `Jude`,
 * `3John`, `Rev`… Qualquer token fora deste vocabulário fechado EXPLODE em
 * `openbibleBookToUsfm` — determinismo é requisito de produto (CLAUDE.md §7).
 */
export const OPENBIBLE_TO_USFM: Readonly<Record<string, UsfmBook>> = {
  Gen: "GEN", Exod: "EXO", Lev: "LEV", Num: "NUM", Deut: "DEU",
  Josh: "JOS", Judg: "JDG", Ruth: "RUT", "1Sam": "1SA", "2Sam": "2SA",
  "1Kgs": "1KI", "2Kgs": "2KI", "1Chr": "1CH", "2Chr": "2CH", Ezra: "EZR",
  Neh: "NEH", Esth: "EST", Job: "JOB", Ps: "PSA", Prov: "PRO",
  Eccl: "ECC", Song: "SNG", Isa: "ISA", Jer: "JER", Lam: "LAM",
  Ezek: "EZK", Dan: "DAN", Hos: "HOS", Joel: "JOL", Amos: "AMO",
  Obad: "OBA", Jonah: "JON", Mic: "MIC", Nah: "NAM", Hab: "HAB",
  Zeph: "ZEP", Hag: "HAG", Zech: "ZEC", Mal: "MAL",
  Matt: "MAT", Mark: "MRK", Luke: "LUK", John: "JHN", Acts: "ACT",
  Rom: "ROM", "1Cor": "1CO", "2Cor": "2CO", Gal: "GAL", Eph: "EPH",
  Phil: "PHP", Col: "COL", "1Thess": "1TH", "2Thess": "2TH", "1Tim": "1TI",
  "2Tim": "2TI", Titus: "TIT", Phlm: "PHM", Heb: "HEB", Jas: "JAS",
  "1Pet": "1PE", "2Pet": "2PE", "1John": "1JN", "2John": "2JN", "3John": "3JN",
  Jude: "JUD", Rev: "REV",
};

/**
 * Códigos deuterocanônicos padrão SBL/OSIS. **O corpus OpenBible pinado NÃO
 * usa nenhum deles** — é referência estritamente protestante de 66 livros
 * (verificado: exatamente 66 tokens distintos, todos em `OPENBIBLE_TO_USFM`).
 *
 * Este conjunto existe como GUARDA-FUTURA da política OQ-4: se um refresh do
 * upstream passar a citar endpoints deuterocanônicos, eles são **descartados
 * com estatística** (não explodem), e o parser falha se a taxa ultrapassar o
 * teto (ver `parser.ts`). Um token que não esteja nem aqui nem no mapa canônico
 * continua EXPLODINDO (vocabulário fechado — pode ser bug de parse).
 */
export const DEUTEROCANONICAL_OPENBIBLE_BOOKS: ReadonlySet<string> = new Set([
  "Tob", "Jdt", "Wis", "Sir", "Bar", "EpJer", "1Macc", "2Macc", "3Macc",
  "4Macc", "1Esd", "2Esd", "PrMan", "AddEsth", "PrAzar", "Sus", "Bel",
  "Ps151", "Odes", "PssSol", "EpLao",
]);

export function isCanonicalOpenbibleBook(code: string): boolean {
  return code in OPENBIBLE_TO_USFM;
}

/**
 * Converte código de livro OpenBible → USFM.
 * - código canônico → `UsfmBook`;
 * - deuterocanônico SBL conhecido → `null` (descarte com estatística, OQ-4);
 * - qualquer outro → EXPLODE (vocabulário fechado, erro cedo e claro).
 */
export function openbibleBookToUsfm(code: string): UsfmBook | null {
  const usfm = OPENBIBLE_TO_USFM[code];
  if (usfm) return usfm;
  if (DEUTEROCANONICAL_OPENBIBLE_BOOKS.has(code)) return null;
  throw new Error(`código de livro OpenBible desconhecido: "${code}"`);
}
