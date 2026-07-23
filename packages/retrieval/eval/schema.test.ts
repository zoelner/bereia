import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalCaseSchema, parseEvalCasesJsonl } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = join(HERE, "perguntas-ouro.mock.jsonl");

describe("evalCaseSchema", () => {
  it("aceita um caso mínimo com defaults (limit=10, strict=false)", () => {
    const parsed = evalCaseSchema.parse({
      id: "caso-minimo",
      query: "mock: caso mínimo",
      expectedIds: ["GEN_1_1"],
      note: "placeholder estrutural",
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.strict).toBe(false);
    expect(parsed.translation).toBeUndefined();
  });

  it("aceita translation/limit/strict explícitos", () => {
    const parsed = evalCaseSchema.parse({
      id: "caso-completo",
      query: "mock: caso completo",
      translation: "KJV",
      limit: 5,
      strict: true,
      expectedIds: ["GEN_1_1", "GEN_1_2"],
      note: "placeholder estrutural",
    });
    expect(parsed.translation).toBe("KJV");
    expect(parsed.limit).toBe(5);
    expect(parsed.strict).toBe(true);
  });

  it("rejeita id fora do padrão kebab-case", () => {
    const result = evalCaseSchema.safeParse({
      id: "Caso_Invalido",
      query: "mock: id inválido",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita query vazia", () => {
    const result = evalCaseSchema.safeParse({
      id: "caso-query-vazia",
      query: "",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita expectedIds vazio", () => {
    const result = evalCaseSchema.safeParse({
      id: "caso-sem-ids",
      query: "mock: sem ids",
      expectedIds: [],
      note: "placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita canonical_id inválido em expectedIds", () => {
    const result = evalCaseSchema.safeParse({
      id: "caso-id-invalido",
      query: "mock: id canônico inválido",
      expectedIds: ["nao-e-um-canonical-id"],
      note: "placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita note vazia", () => {
    const result = evalCaseSchema.safeParse({
      id: "caso-note-vazia",
      query: "mock: note vazia",
      expectedIds: ["GEN_1_1"],
      note: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita limit não positivo", () => {
    const result = evalCaseSchema.safeParse({
      id: "caso-limit-zero",
      query: "mock: limit zero",
      expectedIds: ["GEN_1_1"],
      limit: 0,
      note: "placeholder",
    });
    expect(result.success).toBe(false);
  });
});

describe("parseEvalCasesJsonl", () => {
  it("aceita o mock neutro integralmente e preserva a ordem das linhas", () => {
    const content = readFileSync(MOCK_PATH, "utf-8");
    const cases = parseEvalCasesJsonl(content);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
    expect(cases.map((c) => c.id)).toEqual([...new Set(cases.map((c) => c.id))]);
    for (const evalCase of cases) {
      expect(evalCase.query.toLowerCase()).toContain("mock");
      expect(evalCase.note.length).toBeGreaterThan(0);
      expect(evalCase.expectedIds.length).toBeGreaterThan(0);
    }
  });

  it("retorna lista vazia para conteúdo vazio", () => {
    expect(parseEvalCasesJsonl("")).toEqual([]);
  });

  it("rejeita conteúdo sem LF final", () => {
    const line = JSON.stringify({
      id: "sem-lf",
      query: "mock: sem lf",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    expect(() => parseEvalCasesJsonl(line)).toThrow(/LF/);
  });

  it("rejeita linha vazia no meio do arquivo citando o número da linha", () => {
    const line1 = JSON.stringify({
      id: "caso-um",
      query: "mock: caso um",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    const content = `${line1}\n\n`;
    expect(() => parseEvalCasesJsonl(content)).toThrow(/linha 2 vazia/);
  });

  it("rejeita JSON malformado citando o número da linha", () => {
    const content = "{ isto não é json\n";
    expect(() => parseEvalCasesJsonl(content)).toThrow(/linha 1.*JSON válido/);
  });

  it("rejeita linha que não casa o schema citando o número da linha", () => {
    const badLine = JSON.stringify({ id: "caso-malformado", query: "mock: sem expectedIds", note: "placeholder" });
    const content = `${badLine}\n`;
    expect(() => parseEvalCasesJsonl(content)).toThrow(/linha 1 inválida/);
  });

  it("rejeita expectedIds com canonical_id inválido citando o número da linha", () => {
    const goodLine = JSON.stringify({
      id: "caso-ok",
      query: "mock: ok",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    const badLine = JSON.stringify({
      id: "caso-ruim",
      query: "mock: id ruim",
      expectedIds: ["nao-canonico"],
      note: "placeholder",
    });
    const content = `${goodLine}\n${badLine}\n`;
    expect(() => parseEvalCasesJsonl(content)).toThrow(/linha 2 inválida/);
  });

  it("rejeita ids duplicados no arquivo citando a linha da duplicata", () => {
    const line = JSON.stringify({
      id: "caso-repetido",
      query: "mock: repetido",
      expectedIds: ["GEN_1_1"],
      note: "placeholder",
    });
    const content = `${line}\n${line}\n`;
    expect(() => parseEvalCasesJsonl(content)).toThrow(/caso-repetido.*duplicado.*linha 2/s);
  });
});
