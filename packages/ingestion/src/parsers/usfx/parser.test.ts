import { describe, expect, it } from "vitest";
import { parseUsfx } from "./parser.js";
import { usfxSourceInventory } from "./inventory.js";
import { flattenUsfx } from "../usfx.js";

/** USFX sintético (estrutura mock, sem conteúdo teológico real). */
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<usfx>
<languageCode>xxx</languageCode>
<book id="FRT"><id id="FRT">Prefacio mock</id><p>texto de prefacio ignorado</p></book>
<book id="PSA"><id id="PSA">Salmos mock</id><h>Salmos</h><toc level="1">Salmos</toc>
<c id="3" />
<d style="d">Titulo mock do <w s="H1234">capitulo</w> tres.</d>
<q style="q1"><v id="1" bcv="PSA.3.1" />Primeiro <w s="H0001">verso</w> mock<f caller="+"><fr>3:1</fr><ft>nota que nao entra</ft></f> com <add>acrescimo</add>.<ve /></q>
<q style="q1"><v id="2" bcv="PSA.3.2" />Segundo verso mock <nd>NOME</nd>.<ve /></q>
</book>
<book id="MAT"><id id="MAT">Mateus mock</id>
<c id="1" />
<p><v id="1" />Verso um mock.<ve />
<v id="2-3" />Verso em ponte mock.<ve />
<v id="4" /><ve /></p>
<p sfm="s" style="s1"></p>
</book>
</usfx>`;

describe("parseUsfx", () => {
  const bible = parseUsfx(SAMPLE);

  it("pula livros paratextuais com estatística e mantém os canônicos", () => {
    expect(bible.skippedBooks).toEqual(["FRT"]);
    expect([...bible.books.keys()]).toEqual(["PSA", "MAT"]);
  });

  it("descarta notas de rodapé e mantém texto de <w>/<add>/<nd>", () => {
    const psa3 = bible.books.get("PSA")?.get(3);
    expect(psa3?.verses.get(1)?.text).toBe("Primeiro verso mock com acrescimo.");
    expect(psa3?.verses.get(2)?.text).toBe("Segundo verso mock NOME.");
    expect(psa3?.lastVerse).toBe(2);
  });

  it("captura título de Salmo (<d>) como texto antes do v.1", () => {
    expect(bible.books.get("PSA")?.get(3)?.title).toBe("Titulo mock do capitulo tres.");
    expect(bible.books.get("MAT")?.get(1)?.title).toBeNull();
  });

  it("verso em ponte cobre todas as chaves e aponta o mesmo objeto", () => {
    const mat1 = bible.books.get("MAT")?.get(1);
    expect(mat1?.verses.get(2)).toBe(mat1?.verses.get(3));
    expect(mat1?.verses.get(2)).toMatchObject({ verse: 2, verseEnd: 3 });
    expect(mat1?.lastVerse).toBe(4);
  });

  it("marcador sem conteúdo vira texto vazio (verso 'IfEmpty')", () => {
    expect(bible.books.get("MAT")?.get(1)?.verses.get(4)?.text).toBe("");
  });

  it("bcv divergente da posição explode", () => {
    expect(() =>
      parseUsfx(`<usfx><book id="GEN"><c id="1" /><p><v id="1" bcv="GEN.2.1" />x<ve /></p></book></usfx>`),
    ).toThrow(/bcv/);
  });

  it("elemento fora do vocabulário fechado explode", () => {
    expect(() =>
      parseUsfx(`<usfx><book id="GEN"><c id="1" /><p><v id="1" /><estranho>x</estranho><ve /></p></book></usfx>`),
    ).toThrow(/desconhecido/);
  });
});

describe("usfxSourceInventory", () => {
  const inv = usfxSourceInventory(parseUsfx(SAMPLE));

  it("exists/isLast/TextBeforeV1 com refs no vocabulário TVTMS", () => {
    expect(inv.exists({ book: "Psa", chapter: 3, verse: 1, subverse: null })).toBe(true);
    expect(inv.exists({ book: "Psa", chapter: 3, verse: 5, subverse: null })).toBe(false);
    expect(inv.exists({ book: "Mat", chapter: 1, verse: 4, subverse: null })).toBe(false); // vazio
    expect(inv.exists({ book: "Sir", chapter: 1, verse: 1, subverse: null })).toBe(false); // fora do cânon
    expect(inv.isLast({ book: "Psa", chapter: 3, verse: 2, subverse: null })).toBe(true);
    expect(inv.hasTextBeforeV1("Psa", 3)).toBe(true);
    expect(inv.hasTextBeforeV1("Mat", 1)).toBe(false);
  });

  it("wordCount conta palavras do texto normalizado", () => {
    expect(inv.wordCount({ book: "Psa", chapter: 3, verse: 2, subverse: null })).toBe(4);
    expect(inv.wordCount({ book: "Psa", chapter: 3, verse: "Title", subverse: null })).toBe(5);
  });
});

describe("flattenUsfx", () => {
  it("emite cada verso uma única vez, sem vazios, com tradução carimbada", () => {
    const raw = flattenUsfx(parseUsfx(SAMPLE), "MOCK", "Eng-KJV");
    expect(raw).toHaveLength(4); // PSA 3:1-2 + MAT 1:1 + ponte 2-3 (1x); MAT 1:4 vazio fora
    expect(raw.find((v) => v.book === "MAT" && v.verse === 2)).toMatchObject({ verseEnd: 3 });
    expect(raw.every((v) => v.translation === "MOCK" && v.text.length > 0)).toBe(true);
  });
});
