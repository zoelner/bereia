# HANDOFF — Projeto `bereia`
> Plataforma RAG de estudo teológico e homilética. Este documento é o contrato de contexto para execução da Fase 0 e seguintes. Leia integralmente antes de escrever qualquer código.

> **Adendo (2026-07-21):** todos os identificadores técnicos — código, tabelas, colunas, tools MCP, pastas e **campos do JSONL** — são em **inglês**, conforme o glossário normativo em `docs/decisoes.md` (ADR-000). Conteúdo teológico, documentação e commits permanecem em português. Onde este documento usa nomes em PT (ex.: `dados/`, `versiculos_canonicos`, `buscar_tema`), vale o equivalente EN do glossário (`data/`, `canonical_verses`, `search_theme`).

## 1. Visão
Assistente de estudo bíblico e preparação de pregações com:
- **Retrieval 100% determinístico** (mesmo input → mesmos versículos, sempre)
- **Geração ancorada**: a prosa da LLM pode variar na forma, nunca no conteúdo; toda afirmação cita IDs de versículos recuperados; proibido fundir interpretações divergentes (anti-ambiguidade)
- Dois objetivos: (1) conexões temáticas para sermões (fé → grão de mostarda); (2) exegese de paradoxos com contexto histórico-cultural rígido
- Tese estratégica: **LLM é commodity; o moat é o dado curado + retrieval**

## 2. Decisões fechadas (NÃO reabrir sem instrução do dono)
| Tema | Decisão |
|---|---|
| Linguagem | TypeScript strict em tudo; Python confinado ao sidecar de embedding |
| Banco | **Postgres + pgvector, banco único** (vetores + relacional + curadoria). Busca **exata** (sem índice ANN) com tie-break por ID: `ORDER BY embedding <=> $q, id` |
| Embeddings | **BGE-M3** local (CPU), sidecar Python FastAPI. Pesos/revisão pinados |
| Grafo | Relacional (tabela `edges`), cadeias via recursive CTE. Neo4j só se consultas >3 saltos virarem requisito validado |
| Fonte de verdade | **JSONL em `data/canonical/` versionado em Git**. Postgres é projeção descartável/reconstruível. Embeddings derivados ficam fora do Git |
| Curadoria | Log append-only (`curation.jsonl`): `{canonical_id, field, new_value, author, timestamp}`. Edições humanas escrevem na fonte de verdade; flag `human_reviewed` + `reviewed_by`. Fila priorizada por uso/reports/risco doutrinário/centralidade TSK |
| Cânon | **66 livros (39 AT + 27 NT)**. Enum `canon_status` ('protestant' \| 'deuterocanonical') existe desde já; deuterocanônicos fora do MVP |
| Versificação-mestre | **Inglesa/KJV**, normalização via STEPBible TVTMS no parser, ANTES de gravar JSONL. Decisão quase irreversível — documentar no README |
| ID canônico | Formato `BOOK_CHAPTER_VERSE` (ex: `MAT_5_39`), códigos USFM. Irreversível na prática |
| Multilíngue | 3 níveis: (1) estrutural via canonical_id; (2) léxico via Strong (TAHOT/TAGNT); (3) semântico via espaço vetorial compartilhado do BGE-M3. Alinhamento palavra-a-palavra PT↔original: FORA do MVP |
| Entrega PoC | **Servidor MCP** com 2-3 tools; validação técnica. Web mínima só na fase de validação de mercado |
| Stack TS | Node 22+, pnpm workspaces, Zod em todas as fronteiras, Drizzle ORM, Vitest, SDK oficial `@modelcontextprotocol/sdk`. SEM NestJS |
| Repositórios | **Um repo na PoC**. `data/` desenhado para separação futura via `DATA_DIR` (env). Curadoria vai para repo privado quando existir volume |
| Geração | Interface `HomileticGenerator` plugável: impl. Ollama (SLM local 4-8B via Vulkan) e API. Guardrails obrigatórios com modelo pequeno |
| Licença | Código: **PolyForm Noncommercial 1.0** (dual licensing: gratuito não-comercial; comercial só com acordo/royalties). NOTICE com atribuições upstream. **CLA antes do 1º contribuidor externo**. Curadoria futura: privada |
| Dev Container | Adiado. TODO documentado |

## 3. Fontes de dados (todas gratuitas — Fase 1)
- **Almeida Recebida** (PT, domínio público, Textus Receptus) — ebible.org / seven1m/open-bibles (USFX/OSIS)
- **KJV e WEB** (EN, domínio público) — ebible.org
- **STEPBible TAHOT** (AT hebraico tageado: Strong + morfologia) — CC BY 4.0, TSV — github.com/STEPBible/STEPBible-Data
- **STEPBible TAGNT** (NT grego, cobre TR e NA27/28 marcado por edição) — CC BY 4.0, TSV
- **STEPBible TVTMS** (mapa de versificação entre tradições) — CC BY 4.0
- **openscriptures/strongs** (dicionários Strong) — domínio público, XML/JSON
- **OpenBible.info cross-references** (~340k refs, TSV) — CC-BY; TSK original (PD) como alternativa
- Regra: cada fonte baixada ganha `LICENSE.txt` em `data/sources/<fonte>/` com origem, licença e data
- ATENÇÃO: ACF/ARC/ARA/NVI têm copyright — NÃO ingerir. ACF permite citação de até 1.100 versículos, insuficiente para indexação

## 4. Estrutura do repositório
```
bereia/
├── CLAUDE.md              # este documento
├── README.md              # setup em 3 comandos + decisões irreversíveis
├── LICENSE.md             # PolyForm NC 1.0
├── NOTICE.md              # atribuições STEPBible/OpenBible/fontes PD
├── CONTRIBUTING.md        # CLA + convenções
├── docker-compose.yml     # postgres+pgvector (pinado) + embedder
├── .env.example           # DATABASE_URL, EMBEDDER_URL, DATA_DIR
├── data/
│   ├── sources/           # bruto baixado, imutável (gitignore: arquivos grandes)
│   ├── canonical/         # JSONL = FONTE DE VERDADE (no Git)
│   └── derived/           # embeddings-{model_rev}.jsonl (gitignore)
├── packages/
│   ├── core/              # domínio puro: schemas Zod, tipos, RetrievalService, schema Drizzle
│   └── ingestion/         # parsers (USFX, TSV STEPBible, TVTMS), embed batch, load
├── apps/
│   └── mcp-server/        # adaptador fino: search_theme, verse_exegesis, cross_references
├── embedder/              # Python isolado: FastAPI + sentence-transformers/BGE-M3
└── docs/                  # plano-de-fases.md, mapa-de-fontes.md, decisoes.md (ADRs), curadoria.md
```

## 5. Schema (Drizzle → Postgres)
- `canonical_verses(id PK, book, chapter, verse, canon_status, theological_category)`
- `verse_texts(canonical_id FK, translation, text, embedding vector(1024), embedding_model, PK(canonical_id, translation))`
- `original_words(canonical_id FK, position, lexeme, strong_id, morphology)`
- `strongs(id PK, language, lemma, transliteration, definition)`
- `edges(source_id, target_id, kind)`  -- kind: 'tsk' | 'thematic' | 'manual'
- `curation_log(id, canonical_id, field, new_value, author, timestamp)`  -- projeção do JSONL
- `reports(id, canonical_id, field, kind, comment, reported_by, timestamp, status)`
- `interpretations(id, canonical_id, view_label, text, tradition, source, human_reviewed, reviewed_by)`  -- ADR-004
- `passage_texts(passage_id, book, chapter, verse_start, verse_end, embedding, …)`  -- ADR-003, vazia até o eval justificar
- Metadados por texto: thematic_tags (text[]), cultural_context, human_reviewed bool, reviewed_by, authorized_levels (text[])
- Todo retrieval aplica hard filter (canon_status, authorized_levels) ANTES do ranking vetorial

## 6. Plano de fases (gates em negrito)
0. **Fundação**: estrutura acima, compose, schema, sidecar, docs, licenças
1. **Ingestão**: download fontes → parsers → normalização TVTMS → JSONL → embed → load
2. **Retrieval**: PgRetrieval + CTEs de referências + **gate: eval com perguntas-ouro + snapshot tests (query → IDs esperados)**
3. **PoC MCP**: 3 tools, teste com 2-3 avaliadores
4. **Geração**: HomileticGenerator + guardrails (validação de IDs citados via Zod, recusa fora de escopo, interpretações divergentes nunca fundidas — apresentadas separadas via `interpretations`) + **gate: eval teológico (paradoxos)**
5. **Enriquecimento + curadoria**: notas via IA (human_reviewed=false) + admin mínimo (fila priorizada → editar → append no log)
6. **Validação de mercado**: web mínima (funil estruturado + split-screen), 10-20 pregadores
7. **Produto**: multi-tenancy, billing, cloud

Dependências: 2←1; 3,4←2; 5 paralelo desde 1; 6←4+5.

## 7. Convenções para o agente
- Perguntar antes de reabrir qualquer decisão da seção 2
- Zod em toda fronteira; nada de `any`; erros explodem cedo com mensagem clara
- Commits pequenos e descritivos em PT, **sem coautoria de IA**
- Identificadores em inglês (glossário: `docs/decisoes.md`); docs e conteúdo teológico em PT
- Nunca inventar dados teológicos/históricos em seeds ou testes — usar placeholders neutros marcados como mock
- Pinnar TODAS as versões (imagens Docker, modelo HF, deps Python)
- Determinismo é requisito de produto: qualquer fonte de não-determinismo no retrieval é bug

## 8. Restrições de ambiente
- Desenvolvimento CPU-only para embeddings; GPU somente via Vulkan/llama.cpp para o SLM futuro
- Em WSL, manter o projeto no filesystem Linux (nunca /mnt/c)
- Estimativas validadas: embed de 1 tradução ≈ 15-35 min em CPU; PG total < 1GB; busca exata < 10ms
