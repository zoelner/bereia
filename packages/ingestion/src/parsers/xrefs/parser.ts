import {
  type CanonicalId,
  type Edge,
  USFM_BOOKS,
  type UsfmBook,
} from "@bereia/core";
import { openbibleBookToUsfm } from "./books.js";

/**
 * Parser das cross-references do OpenBible.info (CC BY 4.0).
 *
 * Formato real levantado (docs/plano-fechamento-fase1.md §2.2; fonte pinada
 * `openbible-xrefs/cross_references.txt`, membro único do zip `9beb9c…`):
 * TSV com cabeçalho `From Verse<TAB>To Verse<TAB>Votes<TAB>#…provenance` e
 * 344.799 linhas de dado no formato `From<TAB>To<TAB>Votes`.
 *
 * ## Decisões (determinismo é requisito de produto — CLAUDE.md §1/§7)
 *
 * - **Versificação já é KJV** (§2.2): NÃO passa pelo mapper TVTMS — só book-map
 *   (`books.ts`) + expansão de range.
 * - **`From` é sempre verso único; `To` pode ser range** (`Ps.148.4-Ps.148.5`).
 * - **Expansão de range (âncora-só vs expansão — o plano decidiu, §2.2/§3.2):**
 *   - Range **intra-capítulo** (mesmo livro e capítulo): expandido AQUI para
 *     **uma edge por verso de destino** (`Ps.148.4-Ps.148.5` → 2 edges). É
 *     totalmente determinístico e não exige inventário.
 *   - Range **inter-capítulo / inter-livro** (ex.: `Judg.10.6-Judg.11.40`,
 *     `2Chr.36.22-Ezra.1.3`): a enumeração dos versos intermediários exige o
 *     **inventário de versos da KJV** (lastVerse por capítulo), que o plano
 *     (§3.2) atribui ao nó de edges (N7). Para NÃO perder os versos do miolo e
 *     manter este parser livre do inventário, tais ranges saem como
 *     `deferredRanges` (par âncora `start`/`end`) que N7 expande contra o
 *     conjunto de `canonical_id` materializado.
 * - **Self-loops** (um verso que se referencia via range que o contém, ex.:
 *   `to = Gen.1.1-Gen.1.3` a partir de `Gen.1.2`) são **mantidos e contados**;
 *   a remoção é responsabilidade de N7 (plano §4). São edges válidas segundo
 *   `edgeSchema` (source == target, ambos ids válidos).
 * - **Votos (OQ-3):** `edgeSchema` não tem coluna de peso; carregamos TODAS as
 *   edges sem voto (inclusive voto negativo — curadoria depois). O voto é lido
 *   e VALIDADO (coluna deve existir e ser inteiro) mas descartado; linhas com
 *   voto negativo são apenas contadas em `stats`.
 * - **Descarte fora-do-cânon (OQ-4):** endpoint cujo livro seja
 *   deuterocanônico conhecido é descartado com estatística; o parse **FALHA** se
 *   a taxa de descarte passar do teto (`DEFAULT_DISCARD_CEILING`, ~0,5%). No
 *   dado pinado a taxa é 0% (corpus 66 livros). Token de livro desconhecido
 *   EXPLODE (vocabulário fechado, `books.ts`).
 * - **Dedupe determinístico:** edges e `deferredRanges` são deduplicados e
 *   ordenados em ordem canônica total e estável (`USFM_BOOKS` → chapter →
 *   verse), garantindo saída byte-idêntica entre builds.
 */

/** Teto da taxa de descarte fora-do-cânon (OQ-4): 0,5%. Acima disso, explode. */
export const DEFAULT_DISCARD_CEILING = 0.005;

/** Range inter-capítulo/inter-livro delegado a N7 (expansão contra o cânon). */
export interface XrefDeferredRange {
  sourceId: CanonicalId;
  /** Verso inicial do range de destino (âncora `start`). */
  targetStartId: CanonicalId;
  /** Verso final do range de destino (âncora `end`). */
  targetEndId: CanonicalId;
}

export interface XrefStats {
  /** Linhas de dado lidas (exclui cabeçalho). */
  dataLines: number;
  /** Edges únicas emitidas (singles + ranges intra-capítulo, self-loops inclusos). */
  edges: number;
  /** Subconjunto de `edges` com source == target (N7 remove). */
  selfLoops: number;
  /** Ranges inter-capítulo/inter-livro delegados a N7. */
  deferredRanges: number;
  /** Linhas cujo voto era negativo (informativo; voto é descartado — OQ-3). */
  negativeVoteLines: number;
  /** Linhas descartadas por endpoint fora do cânon de 66 (OQ-4). */
  discardedOutOfCanon: number;
  /** `discardedOutOfCanon / dataLines`. */
  discardRate: number;
  /** Teto aplicado (para auditoria). */
  discardCeiling: number;
}

export interface XrefParseResult {
  /** Edges `kind:"tsk"`, ordenadas em ordem canônica total e estável. */
  edges: Edge[];
  /** Ranges que N7 expande contra o inventário KJV. */
  deferredRanges: XrefDeferredRange[];
  stats: XrefStats;
}

export interface ParseXrefsOptions {
  /** Sobrescreve o teto de descarte (OQ-4). Default: `DEFAULT_DISCARD_CEILING`. */
  discardCeiling?: number;
}

const HEADER_RE = /^From Verse\tTo Verse\tVotes(\t|$)/;
const REF_RE = /^([0-9A-Za-z]+)\.(\d+)\.(\d+)$/;
const VOTES_RE = /^-?\d+$/;

const BOOK_ORDER: ReadonlyMap<string, number> = new Map(
  USFM_BOOKS.map((book, index) => [book, index]),
);

interface UsfmRef {
  book: UsfmBook;
  chapter: number;
  verse: number;
}

/** `null` = endpoint fora do cânon de 66 (descarte OQ-4). Token novo explode. */
function parseRef(token: string, lineNumber: number): UsfmRef | null {
  const match = REF_RE.exec(token);
  if (!match) {
    throw new Error(`linha ${lineNumber}: referência OpenBible malformada: "${token}"`);
  }
  const book = openbibleBookToUsfm(match[1] as string);
  if (book === null) return null;
  const chapter = Number(match[2]);
  const verse = Number(match[3]);
  // O corpus de cross-refs não referencia títulos (verso 0) nem capítulo 0
  // (plano §2.2). Um .0 seria inesperado — explode (vocabulário fechado).
  if (chapter < 1 || verse < 1) {
    throw new Error(`linha ${lineNumber}: capítulo/verso zero inesperado em "${token}"`);
  }
  return { book, chapter, verse };
}

function toId(ref: UsfmRef): CanonicalId {
  // `book` ∈ UsfmBook (mapa fechado) e chapter/verse ∈ inteiros positivos ⇒ a
  // string casa CANONICAL_ID_PATTERN com livro válido por construção. Invariante
  // provada por `edgeSchema.parse` nos testes (unit + amostra de integração).
  return `${ref.book}_${ref.chapter}_${ref.verse}` as CanonicalId;
}

function canonicalKey(id: CanonicalId): [number, number, number] {
  const [book, chapter, verse] = id.split("_") as [string, string, string];
  const order = BOOK_ORDER.get(book);
  if (order === undefined) throw new Error(`livro fora de USFM_BOOKS em "${id}"`);
  return [order, Number(chapter), Number(verse)];
}

function compareKeys(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function parseXrefs(tsv: string, options: ParseXrefsOptions = {}): XrefParseResult {
  const discardCeiling = options.discardCeiling ?? DEFAULT_DISCARD_CEILING;

  const lines = tsv.split("\n");
  if (lines.length === 0 || !HEADER_RE.test((lines[0] ?? "").replace(/\r$/, ""))) {
    throw new Error(
      `cabeçalho inesperado — esperado "From Verse\\tTo Verse\\tVotes…", veio "${lines[0] ?? ""}"`,
    );
  }

  const edgeKeys = new Set<string>();
  const deferredKeys = new Set<string>();
  let dataLines = 0;
  let negativeVoteLines = 0;
  let discardedOutOfCanon = 0;

  for (let i = 1; i < lines.length; i++) {
    const raw = (lines[i] ?? "").replace(/\r$/, "");
    if (raw.length === 0) continue; // newline final / linhas em branco
    dataLines++;
    const lineNumber = i + 1;

    const cols = raw.split("\t");
    if (cols.length !== 3) {
      throw new Error(`linha ${lineNumber}: esperadas 3 colunas, vieram ${cols.length}: "${raw}"`);
    }
    const [fromToken, toToken, votesToken] = cols as [string, string, string];

    if (!VOTES_RE.test(votesToken)) {
      throw new Error(`linha ${lineNumber}: voto não-inteiro: "${votesToken}"`);
    }
    if (Number(votesToken) < 0) negativeVoteLines++;

    const from = parseRef(fromToken, lineNumber);

    if (toToken.includes("-")) {
      const parts = toToken.split("-");
      if (parts.length !== 2) {
        throw new Error(`linha ${lineNumber}: range malformado: "${toToken}"`);
      }
      const start = parseRef(parts[0] as string, lineNumber);
      const end = parseRef(parts[1] as string, lineNumber);

      // Descarte OQ-4: qualquer endpoint fora do cânon de 66 → linha descartada.
      if (from === null || start === null || end === null) {
        discardedOutOfCanon++;
        continue;
      }
      const source = toId(from);
      if (start.book === end.book && start.chapter === end.chapter) {
        // Intra-capítulo: expande aqui, uma edge por verso.
        if (end.verse < start.verse) {
          throw new Error(`linha ${lineNumber}: range decrescente: "${toToken}"`);
        }
        for (let v = start.verse; v <= end.verse; v++) {
          const target = toId({ book: start.book, chapter: start.chapter, verse: v });
          edgeKeys.add(`${source}\t${target}`);
        }
      } else {
        // Inter-capítulo/inter-livro: delega a expansão a N7.
        const target = toId(start);
        const targetEnd = toId(end);
        deferredKeys.add(`${source}\t${target}\t${targetEnd}`);
      }
    } else {
      const to = parseRef(toToken, lineNumber);
      if (from === null || to === null) {
        discardedOutOfCanon++;
        continue;
      }
      edgeKeys.add(`${toId(from)}\t${toId(to)}`);
    }
  }

  const discardRate = dataLines === 0 ? 0 : discardedOutOfCanon / dataLines;
  if (discardRate > discardCeiling) {
    throw new Error(
      `taxa de descarte fora-do-cânon ${(discardRate * 100).toFixed(3)}% > teto ` +
        `${(discardCeiling * 100).toFixed(3)}% (${discardedOutOfCanon}/${dataLines}) — ` +
        `possível drift de versificação/upstream (OQ-4)`,
    );
  }

  const edges: Edge[] = Array.from(edgeKeys, (key) => {
    const [sourceId, targetId] = key.split("\t") as [CanonicalId, CanonicalId];
    return { sourceId, targetId, kind: "tsk" as const };
  });
  edges.sort(
    (a, b) =>
      compareKeys(canonicalKey(a.sourceId), canonicalKey(b.sourceId)) ||
      compareKeys(canonicalKey(a.targetId), canonicalKey(b.targetId)),
  );

  const deferredRanges: XrefDeferredRange[] = Array.from(deferredKeys, (key) => {
    const [sourceId, targetStartId, targetEndId] = key.split("\t") as [
      CanonicalId,
      CanonicalId,
      CanonicalId,
    ];
    return { sourceId, targetStartId, targetEndId };
  });
  deferredRanges.sort(
    (a, b) =>
      compareKeys(canonicalKey(a.sourceId), canonicalKey(b.sourceId)) ||
      compareKeys(canonicalKey(a.targetStartId), canonicalKey(b.targetStartId)) ||
      compareKeys(canonicalKey(a.targetEndId), canonicalKey(b.targetEndId)),
  );

  const selfLoops = edges.reduce((n, e) => (e.sourceId === e.targetId ? n + 1 : n), 0);

  return {
    edges,
    deferredRanges,
    stats: {
      dataLines,
      edges: edges.length,
      selfLoops,
      deferredRanges: deferredRanges.length,
      negativeVoteLines,
      discardedOutOfCanon,
      discardRate,
      discardCeiling,
    },
  };
}
