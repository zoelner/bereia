# bereia

Plataforma de estudo bíblico e preparação homilética baseada em RAG: retrieval **100% determinístico** sobre dados curados, com geração ancorada — toda afirmação cita os versículos recuperados, e interpretações divergentes nunca são fundidas.

**Status:** Fase 0 (fundação). Roadmap completo em [`docs/plano-de-fases.md`](docs/plano-de-fases.md).

## Setup em 3 comandos

```sh
docker compose up -d        # postgres+pgvector e sidecar de embedding (BGE-M3, CPU)
corepack pnpm install
corepack pnpm test
```

Requisitos: Node ≥ 22, Docker. Copie `.env.example` para `.env` se precisar alterar portas/credenciais.

## Arquitetura em uma olhada

- **Fonte de verdade:** JSONL em `data/canonical/`, versionado em Git. O Postgres é uma projeção descartável e reconstruível.
- **Retrieval:** Postgres + pgvector em banco único, busca **exata** (sem ANN) com tie-break por ID — mesmo input, mesmos versículos, sempre.
- **Embeddings:** BGE-M3 local (CPU) via sidecar Python (`embedder/`), com modelo e revisão pinados.
- **Grafo de referências:** relacional (`edges`), cadeias via recursive CTE.
- **Entrega da PoC:** servidor MCP com 3 tools (`search_theme`, `verse_exegesis`, `cross_references`).

```
packages/core       # domínio puro: schemas Zod, schema Drizzle, contrato de retrieval
packages/ingestion  # parsers (USFX, STEPBible TSV, TVTMS), embed em lote, load
apps/mcp-server     # adaptador fino sobre o core
embedder/           # sidecar FastAPI + sentence-transformers/BGE-M3
data/               # sources/ (bruto), canonical/ (JSONL no Git), derived/ (fora do Git)
docs/               # plano de fases, decisões (ADRs), mapa de fontes, curadoria
```

## Decisões irreversíveis

Documentadas em [`docs/decisoes.md`](docs/decisoes.md). As que você precisa saber antes de tocar em dados:

1. **ID canônico** `BOOK_CHAPTER_VERSE` com códigos de livro **USFM** (ex.: `MAT_5_39`).
2. **Versificação-mestre inglesa/KJV**, normalizada via STEPBible TVTMS **antes** de gravar qualquer JSONL.
3. **Nomes de campo do JSONL em inglês** (`canonical_id`, `human_reviewed`, …) — o JSONL é fonte de verdade versionada.

## Licença

Código sob [PolyForm Noncommercial 1.0.0](LICENSE.md): uso não-comercial gratuito; uso comercial somente mediante acordo. Atribuições das fontes de dados em [NOTICE.md](NOTICE.md). Contribuições: leia [CONTRIBUTING.md](CONTRIBUTING.md).
