import sax from "sax";
import { strongsEntrySchema, type StrongsEntry } from "@bereia/core";
import { StrongsParseError, toCanonicalStrongId } from "./index.js";

/**
 * Leitor do dicionário Strong GREGO `strongsgreek.xml` (DTD próprio, openscriptures, PD).
 *
 * Estrutura real levantada (docs/plano-fechamento-fase1.md §2.1; 5624 `<entry>`):
 * ```xml
 * <entry strongs="00001">
 *   <strongs>1</strongs> <greek BETA="*A" unicode="Α" translit="A"/> <pronunciation strongs="al'-fah"/>
 *   <strongs_derivation>of Hebrew origin;</strongs_derivation>
 *   <strongs_def> the first letter…</strongs_def><kjv_def>--Alpha.</kjv_def>
 *   Often used … <see language="GREEK" strongs="427"/>
 * </entry>
 * ```
 *
 * Mapeamento para `strongsEntrySchema`:
 * - `id`   = atributo `strongs` (`00001`) normalizado para `/^[HG]\d{4}$/` (`G0001`).
 * - `lemma` = `unicode` do PRIMEIRO `<greek>` (o lema; os demais `<greek>` são ilustrações
 *            aninhadas nas definições). `transliteration` = `translit` desse mesmo `<greek>`.
 * - `definition` = todo o texto da entrada, ver a política abaixo.
 *
 * ## Entradas "Not Used" (101 casos, ex.: strongs 02717)
 * `<entry strongs="02717"><strongs>2717</strongs>  Not Used</entry>`: número reservado sem
 * palavra grega. Não há `<greek>` → sem lema nem transliteração. Para respeitar o schema
 * (`lemma` não-vazio) SEM inventar, o `lemma` recebe o próprio texto da fonte ("Not Used") e
 * `transliteration` fica `null`. São emitidos (contam para os 5624) porque nunca são referenciados
 * por `original_words` — não quebram FK, e o total é âncora do manifest (ADR-008).
 *
 * ## Política de texto da definição (tratamento consciente de markup — plano §3.1)
 * "Tags internas viram texto puro, sem inventar conteúdo": concatena-se, em ordem de documento,
 * TODO o texto da entrada, EXCETO o número em `<strongs>` (redundante com o id). Consequências:
 * - `<strongs_derivation>`, `<strongs_def>`, `<kjv_def>` e o texto solto (PCDATA) após eles são
 *   conteúdo de definição e ENTRAM (preservar conteúdo, não descartar).
 * - `<latin>` (glosa latina aninhada) entra como texto.
 * - Elementos de REFERÊNCIA/metadado vazios (`<greek/>`, `<pronunciation/>`, `<strongsref/>`,
 *   `<see/>`) não têm nó de texto → NÃO contribuem; não fabricamos texto a partir de atributos.
 *
 * Vocabulário FECHADO (ADR-008): elemento fora do observado nas fontes reais pinadas EXPLODE.
 */

/** Elementos permitidos DENTRO de uma `<entry>`. Desconhecido → explode. */
const ENTRY_ELEMENTS = new Set([
  "strongs",
  "greek",
  "pronunciation",
  "strongs_def",
  "strongs_derivation",
  "kjv_def",
  "latin",
  "see",
  "strongsref",
]);

interface OpenElement {
  suppresses: boolean;
}

interface EntryDraft {
  id: string;
  lemma: string | null;
  transliteration: string | null;
  definitionBuffer: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseStrongsGreek(xml: string): StrongsEntry[] {
  const entries: StrongsEntry[] = [];

  let draft: EntryDraft | null = null;
  const stack: OpenElement[] = [];
  let suppressDepth = 0;

  const fail = (message: string): never => {
    const where = draft ? `entrada ${draft.id}` : "(fora de entrada)";
    throw new StrongsParseError(`grego, ${where}: ${message}`);
  };

  const parser = sax.parser(true, { trim: false });

  parser.onerror = (err) => {
    throw new StrongsParseError(`XML grego malformado: ${err.message}`);
  };

  parser.onopentag = (node) => {
    const name = node.name;

    if (draft === null) {
      // Fora de entrada: `<strongsdictionary>`, `<prologue>`, `<entries>` são ignorados.
      if (name === "entry") {
        const strongsAttr = node.attributes["strongs"];
        if (strongsAttr === undefined) {
          throw new StrongsParseError('grego: <entry> sem atributo "strongs"');
        }
        draft = {
          id: toCanonicalStrongId("G", String(strongsAttr)),
          lemma: null,
          transliteration: null,
          definitionBuffer: "",
        };
        stack.length = 0;
        suppressDepth = 0;
      }
      return;
    }

    if (!ENTRY_ELEMENTS.has(name)) {
      fail(`elemento <${name}> fora do vocabulário fechado — atualize o parser conscientemente`);
    }

    let suppresses = false;

    if (name === "strongs") {
      suppresses = true; // o número é redundante com o id — fora da definição
    } else if (name === "greek" && draft.lemma === null) {
      // PRIMEIRO `<greek>`: o lema. Os aninhados nas definições não sobrescrevem.
      const unicode = node.attributes["unicode"];
      if (unicode === undefined || String(unicode).length === 0) {
        fail("primeiro <greek> sem atributo unicode");
      }
      const translit = node.attributes["translit"];
      draft.lemma = String(unicode);
      draft.transliteration =
        translit === undefined || String(translit).length === 0 ? null : String(translit);
    }

    if (suppresses) suppressDepth++;
    stack.push({ suppresses });
  };

  parser.onclosetag = (name) => {
    if (draft === null) return;

    if (name === "entry") {
      const definition = collapse(draft.definitionBuffer);
      // "Not Used" e afins sem <greek>: o lema honesto é o próprio texto da fonte.
      const lemma = draft.lemma ?? definition;
      const entry = strongsEntrySchema.parse({
        id: draft.id,
        language: "greek",
        lemma,
        transliteration: draft.transliteration,
        definition,
      });
      entries.push(entry);
      draft = null;
      stack.length = 0;
      suppressDepth = 0;
      return;
    }

    const top = stack.pop();
    if (top === undefined) return fail(`fechamento </${name}> sem abertura correspondente`);
    if (top.suppresses) suppressDepth--;
  };

  parser.ontext = (text) => {
    if (draft === null || suppressDepth > 0) return;
    draft.definitionBuffer += text;
  };

  parser.write(xml).close();

  if (entries.length === 0) {
    throw new StrongsParseError("grego: nenhuma entrada encontrada — arquivo errado?");
  }
  return entries;
}
