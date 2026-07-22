import sax from "sax";
import { strongsEntrySchema, type StrongsEntry } from "@bereia/core";
import { StrongsParseError, toCanonicalStrongId } from "./index.js";

/**
 * Leitor do dicionário Strong HEBRAICO `StrongHebrewG.xml` (OSIS, openscriptures, PD).
 *
 * Estrutura real levantada (docs/plano-fechamento-fase1.md §2.1; 8674 `<div type="entry">`
 * envoltos num único `<div type="glossary">`):
 * ```xml
 * <div type="entry" n="1">
 *   <w gloss="4a" lemma="אָב" morph="n-m" POS="awb" xlit="ʼâb" ID="H1" xml:lang="heb">אב</w>
 *   <foreign xml:lang="grc"><w gloss="G:1118"/> …</foreign>
 *   <list><item>1) father of an individual</item> …</list>
 *   <note type="exegesis">a primitive word;</note>
 *   <note type="explanation"><hi>father</hi>, in a literal…</note>
 *   <note type="translation">chief, (fore-) father(-less)…</note>
 * </div>
 * ```
 *
 * Mapeamento para `strongsEntrySchema`:
 * - `id`   = atributo `ID` (`H1`) normalizado para a forma canônica `/^[HG]\d{4}$/` (`H0001`).
 *            Não há sufixo de letra no dado real (grep `ID="H\d+[a-z]"` → 0).
 * - `language` = SEMPRE `"hebrew"`. As entradas ARAMAICAS (`xml:lang="arc"`, 653) ficam na
 *            série H e recebem `"hebrew"` (decisão OQ-5 do plano) — o enum do schema é
 *            `hebrew|greek` e a chave é a série, não o idioma litúrgico.
 * - `lemma` = atributo `lemma` (hebraico apontado). `transliteration` = atributo `xlit`.
 * - `definition` = composição DETERMINÍSTICA (ordem do documento) do texto de `<list>`/`<item>`
 *            e das `<note>` de conteúdo. Ver a política de texto abaixo.
 *
 * ## Política de texto da definição (tratamento consciente de markup — plano §3.1)
 * "Tags internas viram texto puro, sem inventar conteúdo": percorre-se a subárvore da entrada
 * em ordem de documento e concatena-se APENAS os nós de texto, colapsando espaços. Consequências:
 * - `<hi>`, `<catchWord>` e afins: a TAG cai, o TEXTO fica.
 * - Elementos de REFERÊNCIA vazios (`<w src=… xlit=…/>` dentro de nota, `<w gloss="G:…"/>` em
 *   `<foreign>`) não têm nó de texto → NÃO contribuem. NÃO fabricamos texto a partir de atributos
 *   (`xlit`/`lemma`): preservar conteúdo, nunca inventar.
 * - `<foreign>` (cross-refs para o grego) é DESCARTADO por inteiro — não é definição.
 * - `<note type="x-typo">` (correção editorial de transliteração, ex.: "xlit X corrected to Y")
 *   é DESCARTADO — é metadado da fonte, não o sentido da palavra. Inclusive quando ANINHADO
 *   dentro de uma nota de conteúdo (ver H58).
 * - O texto do próprio `<w ID=…>` (hebraico NÃO apontado, ex.: "אב") é suprimido: o lema vem do
 *   atributo `lemma` (apontado), que é a forma lexical de referência.
 *
 * Vocabulário FECHADO (ADR-008): elemento, tipo de nota ou `xml:lang` fora do observado nas
 * fontes reais pinadas EXPLODE — nunca passa silencioso.
 */

/** Elementos permitidos DENTRO de uma entrada. Desconhecido → explode. */
const ENTRY_ELEMENTS = new Set(["w", "foreign", "list", "item", "note", "hi", "catchWord"]);

/** Tipos de `<note>` observados. `x-typo` é metadado editorial (descartado da definição). */
const NOTE_TYPES = new Set(["exegesis", "explanation", "translation", "x-typo"]);

/** `xml:lang` observados no `<w>` de entrada. Todos mapeiam para a série H (`"hebrew"`). */
const ENTRY_LANGS = new Set(["heb", "arc", "x-pn"]);

const HEB_ID_RE = /^H(\d+)$/;

interface OpenElement {
  /** Enquanto verdadeiro, o texto desta subárvore fica FORA da definição. */
  suppresses: boolean;
}

interface EntryDraft {
  id: string;
  lemma: string;
  transliteration: string | null;
  definitionBuffer: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseStrongsHebrew(xml: string): StrongsEntry[] {
  const entries: StrongsEntry[] = [];

  let draft: EntryDraft | null = null;
  const stack: OpenElement[] = [];
  let suppressDepth = 0;

  const fail = (message: string): never => {
    const where = draft ? `entrada ${draft.id}` : "(fora de entrada)";
    throw new StrongsParseError(`hebraico, ${where}: ${message}`);
  };

  const parser = sax.parser(true, { trim: false });

  parser.onerror = (err) => {
    throw new StrongsParseError(`XML OSIS malformado: ${err.message}`);
  };

  parser.onopentag = (node) => {
    const name = node.name;

    if (draft === null) {
      // Fora de entrada: só nos interessa abrir uma. `<div type="glossary">` (envelope),
      // header e demais metadados são ignorados de propósito.
      if (name === "div" && node.attributes["type"] === "entry") {
        const idRaw = node.attributes["n"];
        draft = {
          id: `H?(n=${String(idRaw ?? "?")})`, // placeholder até ler o <w ID=…>
          lemma: "",
          transliteration: null,
          definitionBuffer: "",
        };
        stack.length = 0;
        suppressDepth = 0;
      }
      return;
    }

    // Dentro de entrada: vocabulário fechado.
    if (!ENTRY_ELEMENTS.has(name)) {
      fail(`elemento <${name}> fora do vocabulário fechado — atualize o parser conscientemente`);
    }

    let suppresses = false;

    if (name === "w" && node.attributes["ID"] !== undefined) {
      // `<w>` de ENTRADA (tem atributo ID): carrega o lema. Seu texto (não apontado) é suprimido.
      const idAttr = String(node.attributes["ID"]);
      const m = HEB_ID_RE.exec(idAttr);
      if (m === null) fail(`ID="${idAttr}" não casa /^H\\d+$/`);
      const lang = node.attributes["xml:lang"];
      if (lang === undefined || !ENTRY_LANGS.has(String(lang))) {
        fail(`xml:lang="${String(lang)}" fora do vocabulário fechado {heb, arc, x-pn}`);
      }
      const lemma = node.attributes["lemma"];
      if (lemma === undefined || String(lemma).length === 0) fail("atributo lemma ausente/vazio");
      const xlit = node.attributes["xlit"];
      draft.id = toCanonicalStrongId("H", (m as RegExpExecArray)[1] as string);
      draft.lemma = String(lemma);
      draft.transliteration =
        xlit === undefined || String(xlit).length === 0 ? null : String(xlit);
      suppresses = true;
    } else if (name === "foreign") {
      suppresses = true; // cross-refs para o grego: fora da definição
    } else if (name === "note") {
      const type = node.attributes["type"];
      if (type === undefined || !NOTE_TYPES.has(String(type))) {
        fail(`note type="${String(type)}" fora do vocabulário fechado`);
      }
      if (String(type) === "x-typo") suppresses = true; // correção editorial: metadado
    }

    if (suppresses) suppressDepth++;
    stack.push({ suppresses });
  };

  parser.onclosetag = (name) => {
    if (draft === null) return;

    if (name === "div") {
      // Fecha a entrada corrente.
      const definition = collapse(draft.definitionBuffer);
      const entry = strongsEntrySchema.parse({
        id: draft.id,
        language: "hebrew",
        lemma: draft.lemma,
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

  parser.write(xml.replace(/^﻿/, "")).close();

  if (entries.length === 0) {
    throw new StrongsParseError("hebraico: nenhuma entrada encontrada — arquivo errado?");
  }
  return entries;
}
