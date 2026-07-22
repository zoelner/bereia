import { makeCanonicalId } from "@bereia/core";
import { parseTahotRef, stepCanonicalRef, type TahotRef } from "./refs.js";
import { classifyStrong } from "./strongs.js";
import { taggedWordRowSchema, type TaggedWordRow } from "./types.js";

/**
 * Parser dos 4 arquivos TAHOT (AT hebraico amalgamado, STEPBible CC BY 4.0) —
 * uma linha TSV por palavra ortográfica → uma `TaggedWordRow` alinhada ao
 * `canonical_id` mestre (KJV). Reusa N1 (`parseTahotRef`/`stepCanonicalRef`) para
 * a referência e N2 (`classifyStrong`) para o Strong. Vocabulário fechado: linha
 * de palavra fora do formato levantado (docs/plano-stepbible.md §2) EXPLODE com o
 * número da linha — o erro aqui contaminaria `original_words`/`canonical_id`.
 *
 * Layout real (17 colunas fixas; sha256 pinado no manifest):
 *   0 Ref#pos=TextType | 1 Hebraico apontado | 2 Transliteração | 3 Glosa
 *   4 dStrong          | 5 Morfologia ETCBC   | 9 sStrong+Instance | 12 Expanded
 * Só a col 0 (ref/carimbo), 1 (lexeme), 4 (dStrong) e 5 (morfologia) entram na linha.
 */

/** Nº de colunas fixo das 4 fontes TAHOT pinadas — drift de layout deve explodir. */
const TAHOT_COLUMNS = 17;
const COL_REF = 0;
const COL_LEXEME = 1;
const COL_DSTRONG = 4;
const COL_MORPHOLOGY = 5;

/** Uma linha é "por palavra" quando a col 0 traz o marcador `#<pos>=` (inclui 4 díg.). */
const WORD_LINE_RE = /#\d+=/;

export class TahotParseError extends Error {
  constructor(lineNo: number, detail: string) {
    super(`TAHOT linha ${lineNo}: ${detail}`);
    this.name = "TahotParseError";
  }
}

/** Estatística de linhas puladas com motivo (ADR-008: skip nunca silencioso). */
export interface TahotParseStats {
  /** Linhas-por-palavra (col 0 casa `#\d+=`), antes de qualquer skip. */
  wordLines: number;
  /** `TaggedWordRow` efetivamente emitidas. */
  produced: number;
  /** Linhas de livro deuterocanônico (book=null): 0 no TAHOT real, guardado por robustez. */
  skippedDeuterocanonical: number;
  /**
   * Palavras com lexeme vazio: são Qere que OMITEM a palavra do Ketiv/Leningrad
   * (col 1 e glosa vazias, `=Q(K)`), sem lexeme nem Strong para indexar — a
   * substância vive no aparato de variantes (fora do MVP). Puladas com estatística.
   * 14 no dado real pinado (7 em Jos-Est, 7 em Isa-Mal).
   */
  skippedEmptyLexeme: number;
}

export interface TahotParseResult {
  rows: TaggedWordRow[];
  stats: TahotParseStats;
}

/** Palavra TAHOT já classificada (linha-por-palavra válida e com lexeme). */
interface TahotWord {
  ref: TahotRef;
  canonicalId: string;
  lexeme: string;
  dStrong: string;
  morphology: string;
  /** Linha REAL no arquivo (1-based, inclui cabeçalho/licença) — para mensagens de erro. */
  lineNo: number;
}

/**
 * Extrai o(s) Strong(s) lexical(is) do dStrong (col 5) delegando ao N2 POR SEGMENTO.
 *
 * A col 5 do TAHOT NÃO é um único dStrong: combina, além do `/` (prefixo/sufixo)
 * que o N2 já trata, formas que o normalizador do N2 sozinho não cobre — por isso a
 * tokenização fina fica aqui (o N2 permanece fechado e intacto):
 *   - `\`  separa tags de PONTUAÇÃO (maqqef `\H9014`, verseEnd `\H9016`, para `\H9017`);
 *          68 095 linhas reais têm `\` na col 5 (a premissa "col 5 sem `\`" é FALSA no dado).
 *   - `+`  sufixo "esta tag cobre também a próxima palavra hebraica" (`{H8423}+`) — descartado.
 *   - letra minúscula de desambiguação de homônimo próprio (`{H5838x}`, Azarias/Uzias) —
 *          o N2 só aceita a letra MAIÚSCULA; como ela é descartada de qualquer modo, o
 *          segmento é passado em UPPERCASE ao N2 (perda consciente, plano §3.2/Q2).
 *   - `//` e `/ /` (slot vazio/espaço) → segmento vazio, ignorado (pontuação de espaçamento).
 *
 * Cada segmento atômico vira UMA chamada a `classifyStrong` (nunca multi-radical no N2).
 * Retorna todos os radicais lexicais na ordem de leitura. 37 linhas reais têm 2 radicais
 * (palavra ortográfica que une dois lexemas por maqqef, ou Qere que funde duas palavras);
 * `strongId` da linha guarda o PRIMEIRO (o `strongRaw` preserva a col 5 inteira).
 */
function extractStrongRoots(dStrong: string, lineNo: number): string[] {
  const roots: string[] = [];
  for (const punctPart of dStrong.split("\\")) {
    for (const rawSegment of punctPart.split("/")) {
      let segment = rawSegment.trim();
      while (segment.endsWith("+")) segment = segment.slice(0, -1).trim();
      if (segment === "") continue; // slot vazio / espaçamento de pontuação
      let classified;
      try {
        classified = classifyStrong(segment.toUpperCase(), "hebrew");
      } catch (err) {
        throw new TahotParseError(lineNo, `dStrong "${dStrong}": ${(err as Error).message}`);
      }
      if (classified.kind === "lexical") roots.push(classified.strongId);
    }
  }
  return roots;
}

/**
 * Percorre o TSV de UM arquivo TAHOT, classificando cada linha e devolvendo as
 * palavras válidas (linha-por-palavra, canônica, com lexeme) + a estatística de skip.
 * Cabeçalho/licença e as linhas-resumo interlineares (`#`) são ignoradas (não casam
 * `#\d+=`); qualquer linha-por-palavra malformada explode com o número da linha.
 */
function walkTahot(tsv: string): { words: TahotWord[]; stats: TahotParseStats } {
  const words: TahotWord[] = [];
  const stats: TahotParseStats = {
    wordLines: 0,
    produced: 0,
    skippedDeuterocanonical: 0,
    skippedEmptyLexeme: 0,
  };

  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const col0 = tab === -1 ? line : line.slice(0, tab);
    if (!WORD_LINE_RE.test(col0)) continue; // cabeçalho / licença / resumo "#"

    const lineNo = i + 1;
    stats.wordLines += 1;
    const cols = line.split("\t");
    if (cols.length !== TAHOT_COLUMNS) {
      throw new TahotParseError(
        lineNo,
        `esperadas ${TAHOT_COLUMNS} colunas, encontradas ${cols.length}`,
      );
    }

    let ref: TahotRef;
    try {
      ref = parseTahotRef(cols[COL_REF] as string);
    } catch (err) {
      throw new TahotParseError(lineNo, (err as Error).message);
    }

    const canonRef = stepCanonicalRef(ref);
    if (canonRef === null) {
      stats.skippedDeuterocanonical += 1; // livro fora do cânon de 66 — pular com estatística
      continue;
    }

    const lexeme = (cols[COL_LEXEME] as string).trim();
    if (lexeme === "") {
      stats.skippedEmptyLexeme += 1; // Qere que omite a palavra — sem lexeme a indexar
      continue;
    }

    const morphology = (cols[COL_MORPHOLOGY] as string).trim();
    let canonicalId: string;
    try {
      canonicalId = makeCanonicalId(canonRef);
    } catch (err) {
      throw new TahotParseError(lineNo, (err as Error).message);
    }

    words.push({ ref, canonicalId, lexeme, dStrong: cols[COL_DSTRONG] as string, morphology, lineNo });
    stats.produced += 1;
  }

  return { words, stats };
}

/**
 * Parser TAHOT completo (rows + estatística). `parseTahot` expõe só as rows.
 *
 * A `position` da linha NÃO é o `#pos` cru do STEPBible: é uma sequência 1-based
 * densa POR `canonical_id`, na ordem de leitura do arquivo. Motivo (Finding do
 * verifier + evidência do dado): o `#pos` cru NÃO é chave única sob o `canonical_id`
 * (KJV) porque
 *   (a) posições reconstruídas de 4 dígitos (`Gen.4.8#0501`, LXX) codificam um OFFSET
 *       (âncora·palavra + sub-inserção), não uma sequência — 159 no dado real; e
 *   (b) um verso inglês pode agregar DUAS partes de versos hebraicos que reiniciam o
 *       `#pos` em `#01` (`Num.26.1(25.19)#01` + `Num.26.1#01`; casos listados no cabeçalho
 *       STEPBible: Num.26.1, 1Sa.21.1, 1Ki.18.33/20.3/22.22/22.43, 1Ch.12.4, Isa.64.1,
 *       títulos de Salmo).
 * Em ambos, `Number("0001")===Number("01")===1` colidiria em `(canonical_id, position)` —
 * que é PK de `original_words` (CLAUDE.md §5). A sequência por ordem de arquivo é
 * determinística (sha256 pinado), única e preserva a ordem de leitura (as palavras LXX
 * caem no lugar certo entre `#05` e `#06`; a cauda do verso hebraico precede a próxima).
 * O `#pos` cru NÃO é preservado em campo nenhum — perda consciente: `strongRaw` guarda a
 * col 5 (dStrong) inteira, não a col 0 (ref/posição). A rastreabilidade de uma palavra
 * reconstruída (caso (a)) vem de `edition` (TextType com base `"X"`, LXX) combinada com a
 * ordem de leitura densa desta função, não de `strongRaw`.
 */
export function parseTahotDetailed(tsv: string): TahotParseResult {
  const { words, stats } = walkTahot(tsv);
  const nextPosition = new Map<string, number>();
  const rows: TaggedWordRow[] = words.map((word) => {
    // Linha REAL do arquivo (não o índice no array filtrado): a mensagem de erro do dStrong
    // precisa apontar a linha de origem, não uma posição pós-skip inexistente.
    const roots = extractStrongRoots(word.dStrong, word.lineNo);
    const position = (nextPosition.get(word.canonicalId) ?? 0) + 1;
    nextPosition.set(word.canonicalId, position);
    return taggedWordRowSchema.parse({
      canonicalId: word.canonicalId,
      position,
      lexeme: word.lexeme,
      strongId: roots[0] ?? null,
      strongRaw: word.dStrong === "" ? null : word.dStrong,
      morphology: word.morphology === "" ? null : word.morphology,
      edition: word.ref.textType.raw,
    });
  });
  return { rows, stats };
}

/** Port público (ADR-008): TSV de um arquivo TAHOT → palavras tageadas. */
export function parseTahot(tsv: string): TaggedWordRow[] {
  return parseTahotDetailed(tsv).rows;
}

/**
 * Agregação por verso-FONTE (numeração HEBRAICA), insumo do gate de versificação (N5).
 *
 * A chave é a ref hebraica: `ref.hebrew` (parênteses redondos da col 1) quando difere
 * da primária KJV, senão a própria primária. `isTitle` marca que a palavra pertence a
 * um título de Salmo (verso primário/KJV = 0; em hebraico o título é contado como v.1,
 * já refletido em `ref.hebrew`). `wordCount` conta as palavras produzidas (com lexeme).
 *
 * O N5 monta a `SourceInventory` hebraica a partir daqui (contagem por verso, existência,
 * último verso do capítulo, presença de título) e roda `toKjv(hebRef,"Hebrew")` contra a
 * ref primária KJV — a checagem cruzada independente do ADR-002. Ordenação determinística
 * por (ordem de 1ª aparição do livro, capítulo, verso).
 */
export interface HebrewVerseAggregate {
  /** Código STEPBible/TVTMS como na fonte (ex.: "Psa", "Mal", "Jol"). */
  bookCode: string;
  /** Capítulo na numeração hebraica. */
  chapter: number;
  /** Verso na numeração hebraica (título de Salmo → seu verso hebraico, tipicamente 1). */
  verse: number;
  /** Palavras produzidas (com lexeme) neste verso hebraico. */
  wordCount: number;
  /** Verdadeiro se as palavras vêm de um título de Salmo (verso primário/KJV = 0). */
  isTitle: boolean;
}

export function aggregateHebrewVerses(tsv: string): HebrewVerseAggregate[] {
  const { words } = walkTahot(tsv);
  const bookOrder = new Map<string, number>();
  const byKey = new Map<string, HebrewVerseAggregate>();

  for (const word of words) {
    const heb = word.ref.hebrew ?? { chapter: word.ref.chapter, verse: word.ref.verse };
    const bookCode = word.ref.bookCode;
    if (!bookOrder.has(bookCode)) bookOrder.set(bookCode, bookOrder.size);
    const key = `${bookCode}|${heb.chapter}|${heb.verse}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.wordCount += 1;
      existing.isTitle = existing.isTitle || word.ref.verse === 0;
    } else {
      byKey.set(key, {
        bookCode,
        chapter: heb.chapter,
        verse: heb.verse,
        wordCount: 1,
        isTitle: word.ref.verse === 0,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const ba = bookOrder.get(a.bookCode) ?? 0;
    const bb = bookOrder.get(b.bookCode) ?? 0;
    return ba - bb || a.chapter - b.chapter || a.verse - b.verse;
  });
}
