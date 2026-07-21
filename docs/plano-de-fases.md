# Plano de fases

Gates em **negrito** — nenhuma fase avança sem o gate da anterior.

| # | Fase | Entrega | Gate |
|---|------|---------|------|
| 0 | Fundação | Estrutura do repo, compose, schema, sidecar de embedding, docs, licenças | Smoke test: compose sobe, migration roda, testes passam |
| 1 | Ingestão | Download das fontes → parsers → normalização TVTMS → JSONL canônico → embed → load | **Spike TVTMS + suíte de casos-ouro de versificação 100% aprovada antes do 1º JSONL** (ADR-002) |
| 2 | Retrieval | `PgRetrieval` + CTEs de referências cruzadas | **Eval com perguntas-ouro + snapshot tests (query → IDs esperados)** |
| 3 | PoC MCP | 3 tools reais sobre o retrieval | Teste com 2-3 avaliadores |
| 4 | Geração | `HomileticGenerator` plugável (Ollama/API) + guardrails: IDs citados validados via Zod, recusa fora de escopo, interpretações divergentes sempre separadas | **Eval teológico (paradoxos)** |
| 5 | Enriquecimento + curadoria | Notas via IA (`human_reviewed=false`) + admin mínimo (fila priorizada → editar → append no log) | — |
| 6 | Validação de mercado | Web mínima (funil estruturado + split-screen), 10-20 pregadores | Feedback estruturado |
| 7 | Produto | Multi-tenancy, billing, cloud | — |

**Dependências:** 2←1; 3,4←2; 5 corre em paralelo desde 1; 6←4+5.

**Status atual:** Fase 0 concluída na estrutura; smoke test de containers pendente de ambiente Docker.
