import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseUsfx, type UsfxBible } from "./parser.js";
import { usfxSourceInventory, usfxStandardInventory } from "./inventory.js";
import { parseTvtmsExpanded } from "../tvtms/expanded.js";
import { TvtmsMapper } from "../tvtms/mapper.js";

/**
 * Integração contra as FONTES REAIS (data/sources/, fora do Git; CI pula).
 * Fecha o laço do gate ADR-002: os casos-ouro do TVTMS rodando contra a
 * estrutura real da KJV, WEB e Bíblia Livre — não mais Bíblias simuladas.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const dataDir = process.env["DATA_DIR"] ?? path.join(repoRoot, "data");
const src = (rel: string): string => path.join(dataDir, "sources", rel);

const FILES = {
  kjv: src("eng-kjv/eng-kjv_usfx.xml"),
  web: src("eng-web/engwebp_usfx.xml"),
  blivre: src("por-biblialivre/porbr2018_usfx.xml"),
  tvtms: src("stepbible-tvtms/TVTMS.txt"),
};
const hasAll = Object.values(FILES).every((f) => existsSync(f));

function countVerses(bible: UsfxBible): number {
  let n = 0;
  for (const [, chapters] of bible.books) {
    for (const [, ch] of chapters) {
      n += new Set(ch.verses.values()).size;
    }
  }
  return n;
}

describe.skipIf(!hasAll)("USFX real — KJV, WEB e Bíblia Livre", () => {
  let kjv: UsfxBible;
  let web: UsfxBible;
  let blivre: UsfxBible;

  beforeAll(() => {
    kjv = parseUsfx(readFileSync(FILES.kjv, "utf8"));
    web = parseUsfx(readFileSync(FILES.web, "utf8"));
    blivre = parseUsfx(readFileSync(FILES.blivre, "utf8"));
  });

  it("os três parseiam com 66 livros canônicos", () => {
    expect(kjv.books.size).toBe(66);
    expect(web.books.size).toBe(66);
    expect(blivre.books.size).toBe(66);
    expect(blivre.skippedBooks).toEqual([]); // BLIVRE é edição 66 livros
    expect(kjv.skippedBooks).toContain("FRT"); // KJV 1769 traz prefácio + apócrifos
  });

  it("KJV e BLIVRE têm os 31.102 versos clássicos do cânon", () => {
    expect(countVerses(kjv)).toBe(31102);
    expect(countVerses(blivre)).toBe(31102);
  });

  it("assinaturas textuais: At 8:37 e Comma (TR) presentes na KJV e BLIVRE, ausentes na WEB", () => {
    const has = (b: UsfxBible, book: "ACT" | "1JN", ch: number, v: number): boolean =>
      (b.books.get(book)?.get(ch)?.verses.get(v)?.text ?? "") !== "";
    expect(has(kjv, "ACT", 8, 37)).toBe(true);
    expect(has(blivre, "ACT", 8, 37)).toBe(true);
    expect(has(web, "ACT", 8, 37)).toBe(false);
    expect(blivre.books.get("1JN")?.get(5)?.verses.get(7)?.text).toMatch(/céu/);
  });

  it("títulos de Salmos capturados como texto antes do v.1", () => {
    expect(kjv.books.get("PSA")?.get(3)?.title).toMatch(/Psalm of David/);
    expect(blivre.books.get("PSA")?.get(3)?.title).not.toBeNull();
    expect(kjv.books.get("PSA")?.get(1)?.title).toBeNull(); // Sl 1 não tem título
  });

  it("zero versos em ponte no cânon de 66 (as pontes da WEB estão só nos apócrifos, pulados)", () => {
    let bridges = 0;
    for (const bible of [kjv, web, blivre]) {
      for (const [, chapters] of bible.books) {
        for (const [, ch] of chapters) {
          for (const v of new Set(ch.verses.values())) {
            if (v.verseEnd > v.verse) bridges++;
          }
        }
      }
    }
    expect(bridges).toBe(0); // se uma fonte futura trouxer pontes, isto acusa a decisão pendente
    expect(web.books.get("3JN")?.get(1)?.lastVerse).toBe(14); // WEB segue numeração KJV aqui
    expect(kjv.books.get("3JN")?.get(1)?.lastVerse).toBe(14);
  });
});

describe.skipIf(!hasAll)("gate ADR-002 fechado: TVTMS × inventários REAIS", () => {
  let mapperKjv: TvtmsMapper;
  let mapperWeb: TvtmsMapper;
  let mapperBlivre: TvtmsMapper;

  beforeAll(() => {
    const { rules } = parseTvtmsExpanded(readFileSync(FILES.tvtms, "utf8"));
    const kjv = parseUsfx(readFileSync(FILES.kjv, "utf8"));
    const std = usfxStandardInventory(kjv); // a KJV É a versificação-mestre
    mapperKjv = new TvtmsMapper(rules, usfxSourceInventory(kjv), std);
    mapperWeb = new TvtmsMapper(
      rules,
      usfxSourceInventory(parseUsfx(readFileSync(FILES.web, "utf8"))),
      std,
    );
    mapperBlivre = new TvtmsMapper(
      rules,
      usfxSourceInventory(parseUsfx(readFileSync(FILES.blivre, "utf8"))),
      std,
    );
  });

  it("KJV → mestre é identidade nos casos-ouro (ela É a versificação-mestre)", () => {
    const cases: [string, number, number][] = [
      ["PSA", 3, 1], ["PSA", 3, 8], ["MAL", 4, 1], ["MAL", 4, 6],
      ["JOL", 3, 1], ["JOL", 3, 21], ["ACT", 8, 37], ["3JN", 1, 14], ["ROM", 16, 25],
    ];
    for (const [book, chapter, verse] of cases) {
      expect(
        mapperKjv.toKjv({ book: book as never, chapter, verse, tradition: "Eng-KJV" }),
        `${book} ${chapter}:${verse}`,
      ).toEqual([{ book, chapter, verse, subverse: null }]);
    }
  });

  it("BLIVRE (TR, tradição inglesa) é identidade nos mesmos casos", () => {
    const cases: [string, number, number][] = [
      ["PSA", 3, 1], ["MAL", 4, 1], ["JOL", 3, 1], ["ACT", 8, 37], ["3JN", 1, 14],
    ];
    for (const [book, chapter, verse] of cases) {
      expect(
        mapperBlivre.toKjv({ book: book as never, chapter, verse, tradition: "Eng-KJV" }),
        `${book} ${chapter}:${verse}`,
      ).toEqual([{ book, chapter, verse, subverse: null }]);
    }
  });

  it("WEB: 3Jo 1:14 é identidade (nenhuma das nossas fontes numera até 15 — o caso 15→14 fica no golden simulado)", () => {
    expect(mapperWeb.toKjv({ book: "3JN", chapter: 1, verse: 14, tradition: "Eng-KJV" })).toEqual([
      { book: "3JN", chapter: 1, verse: 14, subverse: null },
    ]);
  });

  it("WEB: Salmos e Malaquias seguem a numeração inglesa (identidade)", () => {
    expect(mapperWeb.toKjv({ book: "PSA", chapter: 3, verse: 1, tradition: "Eng-KJV" })).toEqual([
      { book: "PSA", chapter: 3, verse: 1, subverse: null },
    ]);
    expect(mapperWeb.toKjv({ book: "MAL", chapter: 4, verse: 1, tradition: "Eng-KJV" })).toEqual([
      { book: "MAL", chapter: 4, verse: 1, subverse: null },
    ]);
  });
});

if (!hasAll) {
  it("fontes USFX/TVTMS ausentes — integração PULADA (ver manifest.json)", () => {
    expect(hasAll).toBe(false);
  });
}
