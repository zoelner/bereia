# Decisões (ADRs) — `bereia`

> Identificadores de código e campos de dados em **inglês**; conteúdo teológico, docs e commits em **português**.
> Status geral: **PROPOSTO** — aguarda aprovação antes de virar código/JSONL.

## ADR-000 — Glossário PT→EN

Nomes definitivos dos identificadores (os campos do JSONL são irreversíveis):

- **Pastas:** `data/` (`sources/`, `canonical/`, `derived/`)
- **Tabelas:** `canonical_verses`, `verse_texts`, `original_words`, `strongs`, `edges`, `curation_log`, `reports`
- **Colunas-chave:** `book`, `chapter`, `verse`, `canon_status` (`protestant`|`deuterocanonical`), `theological_category`, `translation` (não `version`), `text`, `embedding`, `embedding_model`, `position`, `lexeme`, `strong_id`, `morphology`, `source_id`, `target_id`, `kind` (`tsk`|`thematic`|`manual`)
- **Metadados:** `thematic_tags`, `cultural_context`, `human_reviewed`, `reviewed_by`, `authorized_levels`
- **JSONL:** `canonical_id`; log de curadoria `{canonical_id, field, new_value, author, timestamp}`
- **Tipos Zod:** `CanonicalVerse`, `VerseText`, `Edge`, `CurationEntry`, `Report`, `User`
- **Tools MCP:** `search_theme`, `verse_exegesis`, `cross_references`

## ADR-001 — Códigos de livro USFM

`canonical_id` = `BOOK_CHAPTER_VERSE` com códigos **USFM/Paratext** de 3 letras (`GEN`…`REV`). Padrão da indústria e neutro de idioma. Parsers mapeiam os nomes de cada fonte → USFM via tabela versionada.

## ADR-002 — Versificação via TVTMS (gate da Fase 1)

Versificação-mestre KJV, normalizada via STEPBible TVTMS **antes** de gravar JSONL. Erro aqui contamina `canonical_id` sistematicamente, então: spike isolado do TVTMS + suíte de casos-ouro (títulos de Salmos, Ml 3/4, Jl 2/3, 3Jo, Rm 16:25-27, versos ausentes em textos críticos como At 8:37) com 100% de aprovação antes do primeiro `data/canonical/*.jsonl`.

## ADR-003 — Embedding: verso como base, perícope aditiva

1 vetor por verso é a base (precisão de ID + determinismo). Para recall temático, espaço adicional por perícope: tabela `passage_texts(passage_id, book, chapter, verse_start, verse_end, embedding, …)`, criada já na Fase 0 (vazia), populada quando o eval justificar. `search_theme` pode consultar perícopes e expandir para IDs de verso.

## ADR-004 — Ajustes de schema

- **Interpretações múltiplas:** tabela `interpretations(id, canonical_id, view_label, text, tradition, source, human_reviewed, reviewed_by)` em vez de flag. A geração apresenta as linhas **separadas**, nunca fundidas.
- **`theological_category`** = taxonomia fechada e curada (1 valor); **`thematic_tags`** = rótulos abertos (array, podem vir de IA não revisada).
- **Acesso:** enum `access_level` + tipo `User { id, access_levels }` desde a Fase 0 (hardcoded na PoC). Hard filter aplicado **antes** do ranking vetorial.

## ADR-005 — Determinismo por build de embedder

Vetores são reprodutíveis por **build** (modelo + revisão HF + deps pinadas), não entre builds distintos. `embedding_model` carimba a revisão em cada linha; `GET /health` expõe modelo+revisão e trava ingestão contra build divergente; teste de regressão (hash de vetores de um conjunto fixo) no CI. Re-embed exige bump explícito de revisão.

## ADR-006 — Fontes brutas: proveniência versionada, não redistribuição

Arquivos brutos de `data/sources/` ficam **fora do Git**: o STEPBible pede explicitamente para não redistribuir (atualizações fluem da fonte única) e o volume (dezenas de MB) incharia o repo. A auditabilidade vem de `data/sources/manifest.json`, versionado, com URL, commit do upstream, **sha256** e data de cada fonte — o pipeline de download da Fase 1 verifica os hashes, e um auditor reproduz o dado byte a byte a partir da origem oficial. Cadeia auditável: manifest (hash pinado) → parsers determinísticos → JSONL canônico (no Git) → Postgres (projeção).

## ADR-007 — Arquitetura hexagonal: alinhamento sem cerimônia

O desenho atual **já é hexagonal no que importa**: `packages/core` é o hexágono (domínio + ports: `RetrievalService`, futuro `HomileticGenerator`; `VersificationMapper`/`SourceInventory` são ports da ingestão), `apps/mcp-server` é adapter primário, parsers/embedder/Postgres são adapters secundários. Decisão: **não introduzir cerimônia** (pastas ports/adapters, DI container) na PoC — o custo não paga em repo solo cujo moat é dado, não framework. O que vale desde já é a **regra de dependência**, verificada em revisão: `core` não importa de `ingestion` nem de `apps`; `ingestion` não importa de `apps`; adapters dependem de ports, nunca o contrário. Desvio consciente e aceito: o schema Drizzle vive no `core` (é contrato declarativo da projeção, sem I/O); na Fase 2 o `PgRetrieval` nasce **fora** do `core` (adapter próprio) e, se a pureza apertar, o schema migra junto — reavaliar nesse momento, não antes.

## ADR-008 — Testes ancorados em requisito, não em implementação

Testes só mudam quando um **requisito** muda; refatorar implementação não pode exigir reescrever teste — se exigir, ou o teste estava acoplado errado, ou o contrato mudou de fato (e isso pede ADR/decisão, não ajuste silencioso). Âncoras válidas: (1) **ports públicos** (ex.: `toKjv`, estrutura retornada por `parseUsfx`, `RetrievalService`); (2) **formatos de upstream pinados** — a gramática TVTMS/USFX é requisito externo, então testes de gramática são testes de contrato, não de implementação; (3) **números exatos atrelados ao sha256 do manifest** (ex.: 15.933 regras, 31.102 versos) — mudam somente com bump consciente da fonte. Suítes de integração contra `data/sources/` fazem skip explícito quando o arquivo falta (CI), nunca verde falso; unitários usam estrutura sintética marcada como mock, jamais conteúdo teológico inventado.
