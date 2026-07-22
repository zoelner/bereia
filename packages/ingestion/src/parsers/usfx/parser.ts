import sax from "sax";
import { usfmBookSchema, type UsfmBook } from "@bereia/core";

/**
 * Parser USFX (ebible.org) → estrutura de versos NA VERSIFICAÇÃO DA FONTE.
 *
 * Separa texto canônico de aparato editorial: notas de rodapé, referências
 * cruzadas e títulos de seção modernos NUNCA entram no texto do verso.
 * Títulos de Salmos (<d>) SÃO texto canônico — ficam como `title` do capítulo
 * (é o caso TextBeforeV1 dos Tests do TVTMS).
 *
 * Vocabulário de elementos FECHADO (levantado dos 3 arquivos reais):
 * elemento desconhecido explode em vez de passar despercebido.
 */

export interface UsfxVerse {
  book: UsfmBook;
  chapter: number;
  /** Verso inicial. Igual a verseEnd, salvo pontes ("15-16" na WEB). */
  verse: number;
  verseEnd: number;
  /** Texto canônico normalizado (espaços colapsados); "" = marcador sem conteúdo. */
  text: string;
}

export interface UsfxChapter {
  /** Título de Salmo (<d>) — texto canônico antes do v.1; null quando não há. */
  title: string | null;
  /** Chave: cada verso coberto; versos em ponte apontam o MESMO objeto. */
  verses: Map<number, UsfxVerse>;
  lastVerse: number;
}

export interface UsfxBible {
  books: Map<UsfmBook, Map<number, UsfxChapter>>;
  /** Livros pulados (FRT, GLO, apócrifos) — contados, nunca silenciados. */
  skippedBooks: string[];
}

/** Subárvores descartadas por inteiro: aparato editorial, nunca texto canônico. */
const STRIP_SUBTREE = new Set([
  "f", "fr", "ft", "fq", "fqa", "fl", // notas de rodapé
  "x", "xo", "xt", // referências cruzadas do editor
  "ref", "rq", // rótulos de referência impressos
  "id", "ide", "h", "toc", "cl", "cp", "s", "languageCode", // metadados/títulos de seção
]);

/** Marcação de caractere cujo TEXTO é canônico — a tag cai, o texto fica. */
const KEEP_TEXT = new Set(["add", "nd", "w", "wj", "tl", "qs", "k", "wh", "bk"]);

/** Estruturais: delimitam fluxo, não carregam texto próprio. */
const STRUCTURAL = new Set(["usfx", "book", "p", "q", "b", "c", "v", "ve", "d"]);

const VERSE_ID_RE = /^([0-9]+)(?:-([0-9]+))?$/;

export function parseUsfx(xml: string): UsfxBible {
  const books = new Map<UsfmBook, Map<number, UsfxChapter>>();
  const skippedBooks: string[] = [];

  let currentBook: UsfmBook | null = null;
  let chapters: Map<number, UsfxChapter> | null = null;
  let currentChapter: UsfxChapter | null = null;
  let currentChapterNum = 0;
  let stripDepth = 0;
  let inTitle = false;
  let openVerse: { start: number; end: number; buffer: string } | null = null;
  let titleBuffer = "";

  const fail = (msg: string): never => {
    const where = currentBook ? `${currentBook} ${currentChapterNum}` : "(fora de livro)";
    throw new Error(`USFX inválido em ${where}: ${msg}`);
  };

  const closeVerse = (): void => {
    if (openVerse === null || currentChapter === null || currentBook === null) return;
    const text = openVerse.buffer.replace(/\s+/g, " ").trim();
    const verse: UsfxVerse = {
      book: currentBook,
      chapter: currentChapterNum,
      verse: openVerse.start,
      verseEnd: openVerse.end,
      text,
    };
    for (let v = openVerse.start; v <= openVerse.end; v++) {
      if (currentChapter.verses.has(v)) fail(`verso ${v} duplicado`);
      currentChapter.verses.set(v, verse);
    }
    currentChapter.lastVerse = Math.max(currentChapter.lastVerse, openVerse.end);
    openVerse = null;
  };

  const parser = sax.parser(true, { trim: false });

  parser.onerror = (err) => {
    throw new Error(`XML USFX malformado: ${err.message}`);
  };

  parser.onopentag = (node) => {
    const name = node.name;
    if (STRIP_SUBTREE.has(name)) {
      stripDepth++;
      return;
    }
    if (stripDepth > 0 || KEEP_TEXT.has(name)) return;
    if (!STRUCTURAL.has(name)) {
      fail(`elemento desconhecido <${name}> — vocabulário fechado, atualize o parser conscientemente`);
    }

    switch (name) {
      case "book": {
        const id = String(node.attributes["id"] ?? "");
        const parsed = usfmBookSchema.safeParse(id);
        if (parsed.success) {
          if (books.has(parsed.data)) fail(`livro ${id} duplicado`);
          currentBook = parsed.data;
          chapters = new Map();
          books.set(parsed.data, chapters);
        } else {
          skippedBooks.push(id);
          currentBook = null;
          chapters = null;
        }
        currentChapter = null;
        currentChapterNum = 0;
        break;
      }
      case "c": {
        if (currentBook === null || chapters === null) break; // dentro de livro pulado
        if (openVerse !== null) fail("capítulo aberto com verso ainda aberto");
        const num = Number(node.attributes["id"]);
        if (!Number.isInteger(num) || num <= 0) fail(`capítulo com id inválido "${String(node.attributes["id"])}"`);
        if (chapters.has(num)) fail(`capítulo ${num} duplicado`);
        currentChapter = { title: null, verses: new Map(), lastVerse: 0 };
        currentChapterNum = num;
        chapters.set(num, currentChapter);
        break;
      }
      case "v": {
        if (currentBook === null) break;
        if (currentChapter === null) fail("verso fora de capítulo");
        if (openVerse !== null) fail("verso aberto sobre verso aberto (falta <ve/>)");
        const idRaw = String(node.attributes["id"] ?? "");
        const m = VERSE_ID_RE.exec(idRaw);
        if (!m) fail(`id de verso inválido "${idRaw}"`);
        const start = Number((m as RegExpExecArray)[1]);
        const end = (m as RegExpExecArray)[2] !== undefined ? Number((m as RegExpExecArray)[2]) : start;
        if (end < start) fail(`ponte invertida "${idRaw}"`);
        const bcv = node.attributes["bcv"];
        if (bcv !== undefined && String(bcv) !== `${currentBook}.${currentChapterNum}.${start}`) {
          fail(`bcv="${String(bcv)}" diverge da posição ${currentBook}.${currentChapterNum}.${start}`);
        }
        openVerse = { start, end, buffer: "" };
        break;
      }
      case "ve":
        closeVerse();
        break;
      case "d": {
        if (currentBook === null) break;
        if (currentChapter === null) fail("título (<d>) fora de capítulo");
        // A WEB fecha o verso anterior DENTRO do <d> acróstico (Sl 119):
        // o texto do título vai para o buffer próprio; o <ve/> interno fecha o verso.
        inTitle = true;
        titleBuffer = "";
        break;
      }
      default:
        break; // usfx, p, q, b: só estrutura
    }
  };

  parser.onclosetag = (name) => {
    if (STRIP_SUBTREE.has(name)) {
      stripDepth--;
      return;
    }
    if (stripDepth > 0) return;
    if (name === "d" && inTitle) {
      inTitle = false;
      if (currentChapter !== null) {
        const title = titleBuffer.replace(/\s+/g, " ").trim();
        // Alguns livros têm mais de um <d> no capítulo (ex.: Sl 119) — concatena.
        currentChapter.title = currentChapter.title === null ? title : `${currentChapter.title} ${title}`;
      }
    }
    if (name === "book") {
      closeVerse();
      currentBook = null;
      chapters = null;
      currentChapter = null;
    }
  };

  parser.ontext = (text) => {
    if (stripDepth > 0 || currentBook === null) return;
    if (inTitle) {
      titleBuffer += text;
    } else if (openVerse !== null) {
      openVerse.buffer += text;
    }
  };

  parser.write(xml.replace(/^﻿/, "")).close();

  if (books.size === 0) throw new Error("USFX sem livros canônicos — arquivo errado?");
  return { books, skippedBooks };
}
