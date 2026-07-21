import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canonicalIdSchema, type User } from "@bereia/core";

/**
 * Adaptador fino sobre o core. Fase 0: as 3 tools respondem MOCK —
 * contratos reais, dados vazios. PgRetrieval é ligado na Fase 3.
 */

const MOCK_NOTICE =
  "MOCK (Fase 0): contrato válido, sem dados reais. Nenhum conteúdo teológico é retornado até a ingestão da Fase 1.";

/** Usuário hardcoded da PoC — hard filter real chega com o PgRetrieval. */
const POC_USER: User = { id: "poc", accessLevels: ["public"] };

const server = new McpServer({ name: "bereia", version: "0.1.0" });

server.registerTool(
  "search_theme",
  {
    title: "Busca temática",
    description:
      "Busca versículos por tema (retrieval determinístico: mesmo input, mesmos versículos). Ex.: conexões temáticas para sermões.",
    inputSchema: {
      query: z.string().min(2).describe("Tema ou pergunta, em PT ou EN"),
      translation: z.string().optional().describe("Tradução preferida (opcional)"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, translation, limit }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ notice: MOCK_NOTICE, user: POC_USER.id, query, translation, limit, results: [] }),
      },
    ],
  }),
);

server.registerTool(
  "verse_exegesis",
  {
    title: "Exegese de versículo",
    description:
      "Retorna texto, palavras originais (Strong/morfologia), contexto cultural e interpretações — divergências sempre apresentadas separadas, nunca fundidas.",
    inputSchema: {
      canonicalId: canonicalIdSchema.describe("ID canônico BOOK_CHAPTER_VERSE, ex.: MAT_5_39"),
    },
  },
  async ({ canonicalId }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          notice: MOCK_NOTICE,
          canonicalId,
          texts: [],
          originalWords: [],
          interpretations: [],
        }),
      },
    ],
  }),
);

server.registerTool(
  "cross_references",
  {
    title: "Referências cruzadas",
    description: "Referências cruzadas (TSK/temáticas) de um versículo, com cadeias via grafo relacional.",
    inputSchema: {
      canonicalId: canonicalIdSchema.describe("ID canônico BOOK_CHAPTER_VERSE, ex.: MAT_5_39"),
      maxHops: z.number().int().min(1).max(3).default(1),
    },
  },
  async ({ canonicalId, maxHops }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ notice: MOCK_NOTICE, canonicalId, maxHops, edges: [] }),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
