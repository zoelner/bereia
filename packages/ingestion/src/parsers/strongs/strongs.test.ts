import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { strongsEntrySchema } from "@bereia/core";
import {
  parseStrongsDict,
  parseStrongsGreek,
  parseStrongsHebrew,
  StrongsParseError,
  toCanonicalStrongId,
} from "./index.js";

/**
 * Testes do parser dos dicionários Strong (N1), ancorados em requisito (ADR-008):
 * - Unit com fragmentos XML SINTÉTICOS (marcados como mock) que exercem a ESTRUTURA e a
 *   política de texto — nada de conteúdo teológico inventado, só andaimes estruturais.
 * - Integração com as fontes REAIS (`data/sources/strongs/`), com contagens EXATAS atreladas
 *   ao sha256 do manifest (conferido ANTES de assertar) e `skipIf` quando o arquivo falta.
 */

// ---------------------------------------------------------------------------
// Fragmentos sintéticos (MOCK): estrutura fiel à fonte, conteúdo neutro.
// ---------------------------------------------------------------------------

/** Envelope OSIS mínimo em torno de N entradas hebraicas (MOCK estrutural). */
function hebrewDoc(...entries: string[]): string {
  return `<osis><osisText><div type="glossary">${entries.join("")}</div></osisText></osis>`;
}

/** Envelope do DTD grego em torno de N entradas (MOCK estrutural). */
function greekDoc(...entries: string[]): string {
  return `<entries>${entries.join("")}</entries>`;
}

describe("toCanonicalStrongId — forma canônica /^[HG]\\d{4}$/ (contrato de FK, OQ-6-b)", () => {
  it("zero-padda para 4 dígitos preservando a série", () => {
    expect(toCanonicalStrongId("H", "1")).toBe("H0001");
    expect(toCanonicalStrongId("G", "00001")).toBe("G0001");
    expect(toCanonicalStrongId("H", "8674")).toBe("H8674");
    expect(toCanonicalStrongId("G", "5624")).toBe("G5624");
  });

  it("explode fora de 1..9999 ou com dígitos inválidos (vocabulário fechado)", () => {
    expect(() => toCanonicalStrongId("H", "0")).toThrow(StrongsParseError);
    expect(() => toCanonicalStrongId("G", "10000")).toThrow(StrongsParseError);
    expect(() => toCanonicalStrongId("H", "abc")).toThrow(StrongsParseError);
    expect(() => toCanonicalStrongId("H", "")).toThrow(StrongsParseError);
  });
});

describe("parseStrongsHebrew — OSIS (unit, MOCK estrutural)", () => {
  it("mapeia id/lemma/transliteration/definition e compõe a definição em ordem de documento", () => {
    // Espaçamento entre blocos reproduz a indentação real do OSIS (o parser preserva o
    // whitespace da fonte, colapsado — não injeta separadores).
    const [entry] = parseStrongsHebrew(
      hebrewDoc(
        `<div type="entry" n="1">\n` +
          `<w gloss="4a" lemma="LEMMA_AP" morph="n-m" POS="pos" xlit="translit" ID="H1" xml:lang="heb">LEMMA_RAW</w>\n` +
          `<list>\n<item>1) sense one</item>\n<item>2) sense two</item>\n</list>\n` +
          `<note type="exegesis">a root word;</note>\n` +
          `<note type="explanation"><hi>gloss</hi>, in application</note>\n` +
          `<note type="translation">rendering.</note>\n` +
          `</div>`,
      ),
    );
    expect(entry).toEqual({
      id: "H0001",
      language: "hebrew",
      lemma: "LEMMA_AP",
      transliteration: "translit",
      // `<hi>` vira texto puro; texto não apontado do <w> (LEMMA_RAW) é suprimido.
      definition: "1) sense one 2) sense two a root word; gloss, in application rendering.",
    });
    expect(entry?.definition).not.toContain("LEMMA_RAW");
  });

  it("aramaico (xml:lang=arc) fica na série H com language=hebrew (OQ-5)", () => {
    const [entry] = parseStrongsHebrew(
      hebrewDoc(
        `<div type="entry" n="2"><w lemma="ARAM" xlit="ar" ID="H2" xml:lang="arc">x</w>` +
          `<note type="explanation">meaning</note></div>`,
      ),
    );
    expect(entry?.language).toBe("hebrew");
    expect(entry?.id).toBe("H0002");
  });

  it("descarta <foreign> (cross-refs grego) e <note type=x-typo> (correção editorial), inclusive aninhado", () => {
    const [entry] = parseStrongsHebrew(
      hebrewDoc(
        `<div type="entry" n="58">\n<w lemma="L" xlit="x" ID="H58" xml:lang="heb">r</w>\n` +
          `<foreign xml:lang="grc"><w gloss="G:5"/><w gloss="G:912"/></foreign>\n` +
          `<note type="exegesis">from <w src="24" xlit="ref"/> and <w src="4246" xlit="ref2"/>` +
          `<note type="x-typo">xlit A corrected to <catchWord>B</catchWord></note>; meadow;</note>\n` +
          `<note type="translation">field.</note>\n</div>`,
      ),
    );
    // Elementos de referência vazios não contribuem; a nota x-typo aninhada some.
    expect(entry?.definition).toBe("from and ; meadow; field.");
    expect(entry?.definition).not.toContain("corrected");
    expect(entry?.definition).not.toContain("G:5");
  });

  it("explode em elemento, tipo de nota ou xml:lang fora do vocabulário fechado", () => {
    expect(() =>
      parseStrongsHebrew(
        hebrewDoc(`<div type="entry" n="1"><w lemma="l" xlit="x" ID="H1" xml:lang="heb">r</w><bogus/></div>`),
      ),
    ).toThrow(StrongsParseError);
    expect(() =>
      parseStrongsHebrew(
        hebrewDoc(
          `<div type="entry" n="1"><w lemma="l" xlit="x" ID="H1" xml:lang="heb">r</w><note type="wat">z</note></div>`,
        ),
      ),
    ).toThrow(StrongsParseError);
    expect(() =>
      parseStrongsHebrew(
        hebrewDoc(`<div type="entry" n="1"><w lemma="l" xlit="x" ID="H1" xml:lang="zzz">r</w></div>`),
      ),
    ).toThrow(/vocabul/);
  });
});

describe("parseStrongsGreek — DTD (unit, MOCK estrutural)", () => {
  it("mapeia id/lemma/transliteration e compõe a definição (número <strongs> fora, <latin> dentro)", () => {
    // Espaçamento reproduz o DTD real (leading/trailing spaces em `<strongs_def>` etc.).
    const [entry] = parseStrongsGreek(
      greekDoc(
        `<entry strongs="00001">\n` +
          `<strongs>1</strongs> <greek BETA="*A" unicode="UNI" translit="tr"/> <pronunciation strongs="pron"/>\n` +
          `<strongs_derivation>of origin;</strongs_derivation>` +
          `<strongs_def> the sense <latin>lat</latin> ; </strongs_def><kjv_def>--gloss.</kjv_def>` +
          ` trailing note <see language="GREEK" strongs="427"/></entry>`,
      ),
    );
    expect(entry).toEqual({
      id: "G0001",
      language: "greek",
      lemma: "UNI",
      transliteration: "tr",
      definition: "of origin; the sense lat ; --gloss. trailing note",
    });
    expect(entry?.definition).not.toContain("1"); // o número em <strongs> não entra
  });

  it('entrada "Not Used" (sem <greek>): lema = texto da fonte, transliteration null', () => {
    const [entry] = parseStrongsGreek(
      greekDoc(`<entry strongs="02717"><strongs>2717</strongs>  Not Used\n</entry>`),
    );
    expect(entry).toEqual({
      id: "G2717",
      language: "greek",
      lemma: "Not Used",
      transliteration: null,
      definition: "Not Used",
    });
  });

  it("um <greek> aninhado na definição NÃO sobrescreve o lema", () => {
    const [entry] = parseStrongsGreek(
      greekDoc(
        `<entry strongs="00001"><strongs>1</strongs><greek unicode="LEMMA" translit="a"/>` +
          `<strongs_def>see <greek unicode="OTHER" translit="b"/> here</strongs_def></entry>`,
      ),
    );
    expect(entry?.lemma).toBe("LEMMA");
  });

  it("explode em elemento fora do vocabulário fechado", () => {
    expect(() =>
      parseStrongsGreek(greekDoc(`<entry strongs="00001"><greek unicode="U" translit="t"/><bogus/></entry>`)),
    ).toThrow(StrongsParseError);
  });
});

describe("determinismo — reparsear o mesmo fragmento dá saída idêntica", () => {
  it("hebraico e grego são estáveis byte a byte", () => {
    const h = hebrewDoc(
      `<div type="entry" n="1"><w lemma="l" xlit="x" ID="H1" xml:lang="heb">r</w><note type="translation">t.</note></div>`,
    );
    const g = greekDoc(`<entry strongs="00001"><greek unicode="U" translit="t"/><kjv_def>--g.</kjv_def></entry>`);
    expect(JSON.stringify(parseStrongsHebrew(h))).toBe(JSON.stringify(parseStrongsHebrew(h)));
    expect(JSON.stringify(parseStrongsGreek(g))).toBe(JSON.stringify(parseStrongsGreek(g)));
  });
});

// ---------------------------------------------------------------------------
// Integração: fontes REAIS pinadas. Números atrelados ao sha256 do manifest.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const strongsDir = path.join(dataDir, "sources", "strongs");
const HEBREW_FILE = path.join(strongsDir, "StrongHebrewG.xml");
const GREEK_FILE = path.join(strongsDir, "strongsgreek.xml");
const MANIFEST_FILE = path.join(dataDir, "sources", "manifest.json");

const hasSources = existsSync(HEBREW_FILE) && existsSync(GREEK_FILE) && existsSync(MANIFEST_FILE);

/** Contagens EXATAS atreladas ao manifest (openscriptures commit 0acd2f2…). */
const HEBREW_ENTRIES = 8674;
const GREEK_ENTRIES = 5624;
const GREEK_NOT_USED = 101;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function manifestHash(relFromSources: string): string {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as {
    sources: { strongs: { files: Record<string, string> } };
  };
  const hash = manifest.sources.strongs.files[relFromSources];
  if (hash === undefined) throw new Error(`manifest sem sha256 para ${relFromSources}`);
  return hash;
}

describe.skipIf(!hasSources)("Strong real — números exatos atrelados ao manifest", () => {
  it("os arquivos batem com o sha256 pinado no manifest (âncora ADR-008)", () => {
    expect(sha256(HEBREW_FILE)).toBe(manifestHash("strongs/StrongHebrewG.xml"));
    expect(sha256(GREEK_FILE)).toBe(manifestHash("strongs/strongsgreek.xml"));
  });

  it("hebraico: 8674 entradas, todas na forma canônica /^H\\d{4}$/ e contíguas H0001..H8674", () => {
    const entries = parseStrongsHebrew(readFileSync(HEBREW_FILE, "utf8"));
    expect(entries.length).toBe(HEBREW_ENTRIES);
    expect(entries.every((e) => /^H\d{4}$/.test(e.id))).toBe(true);
    expect(entries.every((e) => e.language === "hebrew")).toBe(true);
    const nums = entries.map((e) => Number(e.id.slice(1))).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(HEBREW_ENTRIES);
    expect(new Set(nums).size).toBe(HEBREW_ENTRIES); // sem colisão de id
  });

  it("grego: 5624 entradas, todas /^G\\d{4}$/ e contíguas G0001..G5624", () => {
    const entries = parseStrongsGreek(readFileSync(GREEK_FILE, "utf8"));
    expect(entries.length).toBe(GREEK_ENTRIES);
    expect(entries.every((e) => /^G\d{4}$/.test(e.id))).toBe(true);
    expect(entries.every((e) => e.language === "greek")).toBe(true);
    const nums = entries.map((e) => Number(e.id.slice(1))).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(GREEK_ENTRIES);
    expect(new Set(nums).size).toBe(GREEK_ENTRIES);
  });

  it('grego: as 101 entradas reservadas "Not Used" são emitidas (não quebram FK, contam no total)', () => {
    const entries = parseStrongsGreek(readFileSync(GREEK_FILE, "utf8"));
    const notUsed = entries.filter((e) => e.definition === "Not Used");
    expect(notUsed.length).toBe(GREEK_NOT_USED);
    // um caso concreto verificado na fonte
    expect(entries.find((e) => e.id === "G2717")).toMatchObject({
      lemma: "Not Used",
      transliteration: null,
    });
  });

  it("toda saída real valida contra strongsEntrySchema (fronteira Zod)", () => {
    const all = parseStrongsDict({
      hebrewXml: readFileSync(HEBREW_FILE, "utf8"),
      greekXml: readFileSync(GREEK_FILE, "utf8"),
    });
    expect(all.length).toBe(HEBREW_ENTRIES + GREEK_ENTRIES);
    for (const e of all) strongsEntrySchema.parse(e);
  });

  it("amostras ancoradas: H1→H0001 (lemma אָב) e G1→G0001 (lemma Α)", () => {
    const heb = parseStrongsHebrew(readFileSync(HEBREW_FILE, "utf8"));
    const h1 = heb.find((e) => e.id === "H0001");
    expect(h1?.lemma).toBe("אָב");
    expect(h1?.transliteration).toBe("ʼâb");
    expect(h1?.definition.startsWith("1) father of an individual")).toBe(true);

    const grk = parseStrongsGreek(readFileSync(GREEK_FILE, "utf8"));
    const g1 = grk.find((e) => e.id === "G0001");
    expect(g1?.lemma).toBe("Α");
    expect(g1?.transliteration).toBe("A");
    expect(g1?.definition).toContain("first letter");
  });
});
