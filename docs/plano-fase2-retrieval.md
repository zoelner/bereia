# Plano — Fase 2 (Retrieval)

> **Status: APROVADO** (2026-07-23) pelo dono, com desfecho das questões em aberto —
> OQ-5: operação **`getExegesis` nova** no port (getVerse intocado; registra ADR-010);
> OQ-2: CTE com **teto maxHops=3, default 1**; OQ-4: eval via **skipIf + Postgres do compose**
> (testcontainer no backlog); OQ-1/3/6/7/8/9: defaults aceitos (novo `packages/retrieval`;
> perguntas-ouro em JSONL versionado com mock neutro no CI e real curado pelo dono;
> critério cobertura `expectedIds ⊆ topN` com strict opt-in; thin client de embedding
> próprio; `passage_texts` segue vazia — ADR-003; schema Drizzle permanece no core — ADR-010).
> Entrega: `PgRetrieval` (adapter de retrieval sobre Postgres+pgvector) + CTEs de referências
> cruzadas. **Gate da fase:** eval com perguntas-ouro + snapshot tests (query → IDs esperados).
> Contexto lido: CLAUDE.md §1/§2/§5/§6/§7/§8; ADR-003/004/005/007/008/009; `packages/core/src/`
> (`retrieval.ts`, `schemas.ts`, `db/schema.ts`, `canon.ts`); `packages/ingestion/src/load/`
> (`embed.ts`, `postgres.ts`); `docs/plano-de-fases.md`; `docs/plano-fechamento-fase1.md` §7 (backlog).
>
> Este documento é **decisão + decomposição**, não implementação. Nenhuma decisão da §2 do
> CLAUDE.md é reaberta. Um ponto **esbarra na §5** (a forma do port `RetrievalService`, âncora
> ADR-008) e está **PARADO em open question** (OQ-5), não decidido aqui.

## 1. Contexto e restrições

- **Retrieval 100% determinístico é requisito de produto** (CLAUDE.md §1/§7). Na Fase 2 isso é o
  próprio objeto: mesmo input → mesmos versículos, sempre. Qualquer fonte de não-determinismo no
  ranking é bug, não tuning.
- **Decisões fechadas que este plano APENAS implementa** (§2, não reabrir):
  - Busca vetorial **EXATA, sem índice ANN**, com tie-break estável por id:
    `ORDER BY embedding <=> $q, id`.
  - **Hard filter** (`canon_status`, `authorized_levels`) aplicado **ANTES** do ranking vetorial
    (na cláusula `WHERE`, nunca em pós-processamento).
  - Grafo **relacional** (tabela `edges`), cadeias via **recursive CTE**; Neo4j só se >3 saltos
    virarem requisito validado.
  - Postgres é **projeção descartável**; a fonte de verdade é o JSONL (agora em `zoelner/bereia-data`,
    ADR-009). A Fase 2 lê a projeção, nunca escreve dado canônico.
- **Determinismo do vetor por build (ADR-005):** os vetores gravados em `verse_texts.embedding`
  são reprodutíveis apenas para a combinação modelo+revisão HF pinada. O retrieval **embeda a query
  com o MESMO build** — senão distância vira ruído. A trava de revisão (`assertExpectedRevision`,
  hoje em `ingestion/load/embed.ts`) vale também no caminho de query.
- **Arquitetura (ADR-007):** `PgRetrieval` nasce **fora do `core`**, como adapter próprio. Este
  plano faz o **desfecho da reavaliação** da localização do schema Drizzle (ver §2.2).
- **Testes ancorados em requisito (ADR-008):** o port público `RetrievalService` é âncora; alterá-lo
  é mudança de contrato, não refactor — por isso a extensão do port (OQ-5) é decisão do dono, não
  ajuste silencioso. Integração contra Postgres real faz `skipIf` explícito quando falta
  `DATABASE_URL` (nunca verde falso), espelhando o que o N10 da Fase 1 já faz.
- **Identificadores EN (ADR-000):** nomes exatamente como os schemas Zod e o glossário.
- **Zod em toda fronteira; nada de `any`; explode cedo** (CLAUDE.md §7).

### 1.1 O que já existe (LIGAR, não reimplementar)

- **Port `RetrievalService`** (`packages/core/src/retrieval.ts`): já define `searchByTheme`,
  `getVerse`, `getCrossReferences`, com as invariantes de determinismo e hard filter documentadas.
  Está **incompleto para o objetivo de exegese** — `getVerse` devolve só `{ verse, texts }`, sem
  `original_words`/`strongs`/`interpretations` (ver §3.1 e OQ-5).
- **Schema Drizzle + migrations** (`packages/core/src/db/schema.ts`, `core/drizzle/0000_init.sql`):
  `verse_texts.embedding vector(1024)` **nullable**, PK `(canonical_id, translation)`; `edges` PK
  `(source_id, target_id, kind)` com FKs para `canonical_verses`; `interpretations`, `original_words`
  (com `strong_id` nullable), `strongs`. **Sem índice ANN** (coerente com busca exata). Hard-filter
  columns já presentes (`canon_status`, `authorized_levels`).
- **Sidecar de embedding** (`embedder/main.py`): `POST /embed` (normalizado), `GET /health`
  (`{model, revision}`), revisão pinada. Cliente injetável e trava ADR-005 já modelados em
  `ingestion/load/embed.ts` (`EmbedderClient`, `assertExpectedRevision`, `EXPECTED_*`).
- **mcp-server stub** (`apps/mcp-server/src/index.ts`): as 3 tools respondem MOCK; a tool
  `verse_exegesis` **já declara** `texts`/`originalWords`/`interpretations` no shape de saída — o
  port precisa entregar isso na Fase 2 para a Fase 3 ligar sem retrabalho.
- **Gate único:** `pnpm gate` = `pnpm -r typecheck && pnpm -r test`; `pnpm-workspace.yaml` cobre
  `packages/*` — um novo `packages/retrieval` entra no gate **sem editar o workspace**.

## 2. Decisão (abordagem)

### 2.1 Onde nasce `PgRetrieval` — novo `packages/retrieval` (proposta, OQ-1)

`PgRetrieval` nasce em **`packages/retrieval`** (pacote novo), adapter secundário que **implementa
o port `RetrievalService` do `core`** e depende de `@bereia/core` + driver `postgres` (mesmo
`postgres@3.4.9` já usado em `ingestion`). Trade-offs das alternativas:

- **(a) novo `packages/retrieval` — RECOMENDADO.** Casa com ADR-007 (“PgRetrieval fora do core”),
  isola a superfície de I/O de leitura, e permite que **tanto** o `mcp-server` (Fase 3) **quanto** o
  `HomileticGenerator` (Fase 4) e o harness de eval dependam dele sem arrastar `sax`/parsers.
  Regra de dependência preservada: `retrieval → core`; `core` não importa ninguém.
- **(b) dentro de `ingestion`.** `ingestion` já tem o driver `postgres`, mas é o **lado de escrita**
  (parsers, load). Misturar leitura force-acopla o `mcp-server` a depender de `ingestion` (com
  `sax` e todo o pipeline de parse) só para ler versos — inchaço e fronteira borrada. Descartado.
- **(c) dentro de `mcp-server`.** Enterra o adapter no adapter primário; a Fase 4 (geração) e o
  harness de eval não conseguem reusar sem duplicar SQL. Descartado.

### 2.2 Desfecho da reavaliação do schema Drizzle (ADR-007) — **fica no `core`**

ADR-007 previu: *“na Fase 2 o `PgRetrieval` nasce fora do core e, se a pureza apertar, o schema
migra junto — reavaliar nesse momento.”* **Reavaliação (proposta, OQ-9): a pureza NÃO aperta —
o schema Drizzle permanece no `core`.** Justificativa:

- O schema é **contrato declarativo sem I/O** — não é adapter. Dois lados o consomem: `ingestion`
  (alvo da projeção; hoje `load/postgres.ts` lê as migrations de `core/drizzle/` e espelha as
  colunas) e `retrieval` (fonte das queries). Movê-lo para `retrieval` obrigaria `ingestion →
  retrieval` (write-side dependendo de read-side) ou duplicação do schema. Ambos pioram a regra de
  dependência.
- O `PgRetrieval` (SQL + conexão + I/O) — que é o que ADR-007 quis tirar do core — **sai** para
  `packages/retrieval`. O core continua com **tipos + schema declarativo + port**, sem I/O.
- Esta é uma **evolução de ADR** (o desfecho da reavaliação prometida), não reabertura da §2.
  A aprovação deste plano registra o desfecho como **ADR-010** (ver OQ-5/OQ-9).

### 2.3 Sem migration nova na Fase 2 (determinismo não pede índice)

A busca é **exata** (§2): um scan sequencial sobre `verse_texts` autorizados, ordenado por `<=>`
com tie-break `, id`. **Nenhum índice ANN** (seria não-determinismo por recall probabilístico —
proibido). Índices B-tree (ex.: `edges(source_id)` para o CTE, filtros de `canon_status`) são
**otimização de latência, não de correção**, e o alvo de <10ms (§8) para ~31k versos × 1024 dims é
folgado no scan exato. **Proposta: Fase 2 não cria migration** — o schema do `core` fica intocado, o
que reforça §2.2. Índices de performance viram backlog explícito (§7), acionáveis por medição, não
por suposição.

### 2.4 Query → embedding: mesmo build pinado, trava no caminho de leitura (ADR-005)

`searchByTheme` transforma a query em vetor pelo **mesmo sidecar pinado** que gerou
`verse_texts.embedding`. O `PgRetrieval` recebe um cliente de embedding injetável (porta mínima:
`health()` + `embed(texts)`), e **antes de consultar** confere `GET /health` contra a revisão
esperada — se divergir, **explode** (distância entre builds diferentes é ruído, não similaridade).
Opcionalmente cruza a revisão contra o `embedding_model` carimbado nas linhas de `verse_texts`
(carimbo `"${MODEL_NAME}@${HF_REVISION}"`, OQ-8 da Fase 1) para garantir que query e corpus vêm do
mesmo build. O cliente de query é **próprio do `retrieval`** (dup mínima do thin client HTTP), para
não acoplar `retrieval → ingestion`; promover um `EmbedderClient` compartilhado ao `core` é
backlog (OQ-7).

### 2.5 `passage_texts` permanece vazia (ADR-003)

`searchByTheme` na Fase 2 consulta **apenas `verse_texts`** (1 vetor por verso = precisão de ID +
determinismo). `passage_texts` (perícope, ADR-003) **fica vazia**; só se o eval demonstrar déficit
de recall temático por granularidade de verso é que a população de perícopes é justificada — e isso
vira um gatilho documentado, não trabalho especulativo da Fase 2 (OQ-8).

## 3. Contrato do port de retrieval

O port `RetrievalService` (core) cobre os **dois objetivos do produto**. As três operações abaixo
são a superfície mínima; a extensão de exegese (3.1) é a única mudança de contrato e depende do dono
(OQ-5).

### 3.1 Exegese com contexto — `getVerse` precisa virar exegese completa

Hoje `getVerse(canonicalId, user)` devolve `{ verse: CanonicalVerse; texts: VerseText[] } | null`.
O objetivo (2) do produto (“exegese de paradoxos com contexto histórico-cultural rígido”) e a tool
`verse_exegesis` (que já declara `originalWords`/`interpretations`) exigem também:

- `original_words` do verso (join `original_words` ⋈ `strongs` por `strong_id`, `strong_id`
  nullable preservado — os estendidos 5-díg. e G6xxx–G7xxx ficam `null`+`strongRaw`, backlog Fase 1);
- `interpretations` do verso — **linhas separadas, NUNCA fundidas** (ADR-004, invariante
  anti-ambiguidade); a operação devolve o array cru, a fusão é proibida em toda camada acima.

**Proposta:** enriquecer a operação (renomear para `getExegesis` **ou** ampliar o retorno de
`getVerse`) para
`{ verse, texts, originalWords: (OriginalWord & { strong?: StrongsEntry })[], interpretations: Interpretation[] } | null`,
sempre sob o mesmo hard filter (`authorized_levels`/`canon_status`). **Isto altera um port âncora
(ADR-008) → decisão do dono (OQ-5).**

### 3.2 Conexões temáticas — `searchByTheme`

`searchByTheme(query, user, options?) → ThemeSearchResult[]` (assinatura atual mantida). Invariantes:

- Hard filter no `WHERE` (`canon_status` permitido; `authorized_levels` ⊇ do usuário) **antes** do
  ranking;
- ranking exato `ORDER BY embedding <=> $q, id` (tie-break por id — determinístico mesmo em empate);
- `options.translation` filtra a tradução; `options.limit` limita (default explícito, ver OQ-6);
- linhas com `embedding IS NULL` são **excluídas** do ranking (não embedadas ainda).

### 3.3 Referências cruzadas — `getCrossReferences` (recursive CTE)

`getCrossReferences(canonicalId, user, { maxHops }) → Edge[]`. Invariantes:

- expansão via **recursive CTE** sobre `edges` (§2), profundidade **limitada** por `maxHops`
  (teto = OQ-2; o stub do mcp-server já limita `maxHops ≤ 3`);
- **anti-ciclo** obrigatório (o CTE carrega o caminho/visitados; sem isso o grafo TSK laça);
- ordem de saída **determinística e total** (ex.: por profundidade, depois `source_id`, `target_id`,
  `kind`);
- hard filter aplicado aos versos alcançados (uma edge para verso não autorizado não vaza).

## 4. Determinismo do ranking (o coração da fase)

Cadeia completa, cada elo determinístico:

1. **query (texto) → vetor**: mesmo build de sidecar pinado (ADR-005). Trava de revisão no caminho
   de leitura (§2.4) garante que o vetor da query vive no **mesmo espaço** dos vetores do corpus.
   Floats do BGE-M3 são bit-a-bit estáveis para o mesmo build/deps — logo a mesma query produz o
   **mesmo vetor**, sempre.
2. **vetor → ranking exato**: `ORDER BY embedding <=> $q, id`. Sem ANN ⇒ sem recall probabilístico;
   o `<=>` é função pura das entradas; o tie-break `, id` remove a única ambiguidade possível
   (distâncias empatadas) com uma chave **total** (PK). Duas execuções da mesma query sobre o mesmo
   corpus retornam a **mesma lista de IDs na mesma ordem**.
3. **hard filter antes do ranking**: o `WHERE` restringe o conjunto ranqueado; mudar o usuário muda
   o conjunto de forma determinística, nunca a ordem relativa dentro do mesmo conjunto.

**Caveat pinado (backlog Fase 1 §7, N9):** floats do BGE-M3 podem divergir **entre
microarquiteturas de CPU** (BLAS). O eval e a projeção `verse_texts.embedding` devem rodar no
**mesmo build/máquina**; divergência é falha **ruidosa** (snapshot quebra), nunca verde falso —
coerente com ADR-005. **Onde o eval pina isto:** os snapshot tests (query → IDs exatos) e a
asserção “rodar a mesma query duas vezes ⇒ resultado idêntico” (§5) são o teste de regressão de
determinismo do retrieval, análogo ao hash de vetores do embed batch.

## 5. Gate da fase — eval com perguntas-ouro + snapshot tests

O gate da Fase 2 (§6 do CLAUDE.md) tem **duas provas**, ambas mensuráveis.

### 5.1 Perguntas-ouro (formato + autoria)

- **Arquivo versionado** `packages/retrieval/eval/perguntas-ouro.jsonl` (dentro do pacote, para o
  gate `pnpm -r test` já rodar). Uma linha por caso, validada por Zod:
  `{ id, query, translation?, limit?, expectedIds: CanonicalId[], note }`.
  `expectedIds` = os versos que o retrieval **deve** trazer para aquela query.
- **Autoria (proposta, OQ-3):** o conteúdo teológico real (query + `expectedIds`) é **curado pelo
  dono** (autoridade teológica) — via `data-steward`, análogo ao N11 da Fase 1. Nunca inventado
  por agente (§7 CLAUDE.md).
- **No CI o fixture é NEUTRO:** `perguntas-ouro.mock.jsonl` com queries/IDs **placeholder marcados
  como mock** (sem afirmação teológica), suficiente para exercitar schema, harness e determinismo
  sem depender do dado real. O arquivo real entra só com curadoria (dado vive em `bereia-data`,
  ADR-009).

### 5.2 Snapshot tests (query → IDs exatos)

Para cada pergunta-ouro, o harness roda `searchByTheme` (e, quando aplicável, `getCrossReferences`)
contra o Postgres carregado e compara os IDs retornados com o esperado. Critérios de aprovação
(proposta, OQ-6):

- **Cobertura:** `expectedIds ⊆ topN` (todo verso esperado aparece nos primeiros N), com N por caso;
  proposta default: exatidão de **prefixo** (os `expectedIds` na ordem exata no topo) para casos
  marcados `strict`, e cobertura em topN para os demais.
- **Determinismo:** a mesma query executada duas vezes ⇒ **lista idêntica** (IDs + ordem). Falha
  aqui reprova o gate independentemente da relevância.
- **Estabilidade de snapshot:** o snapshot (query → IDs) só muda com bump consciente do corpus
  (novo build de `bereia-data`/embeddings) — mudança silenciosa reprova (ADR-008).
- **Onde roda (proposta, OQ-4):** contra o Postgres real do `docker-compose` já carregado por
  `load:postgres`, com `skipIf(!DATABASE_URL)` (espelha o N10 da Fase 1 — nunca verde falso). O gate
  “de verdade” exige o DB up com o dado de `bereia-data`; testcontainer é backlog (OQ-4).

## 6. Decomposição em nós

`scope.paths` disjuntos entre nós do mesmo grupo paralelo. Branch por nó `node/<id>`; gate completo
`pnpm gate` antes de PR (ORCHESTRATION.md). Comando de aceite por nó abaixo e em §6.1.

| Nó | Tier | Agente | Grupo | Depende | Escopo (arquivos, disjuntos no grupo) |
|---|---|---|---|---|---|
| N1 port-exegese *(muda port, OQ-5)* | hard | ts-impl | G0 | — | `packages/core/src/retrieval.ts`, `packages/core/src/retrieval.test.ts` |
| N2 pkg-scaffold + query-embedder | standard | ts-impl | G1 | N1 | `packages/retrieval/package.json`, `packages/retrieval/tsconfig.json`, `packages/retrieval/src/index.ts`, `packages/retrieval/src/embedder.ts`, `packages/retrieval/src/embedder.test.ts` |
| N3 search-theme | hard | ts-impl | G2 | N2 | `packages/retrieval/src/search-theme.ts`, `packages/retrieval/src/search-theme.test.ts` |
| N4 exegesis | standard | ts-impl | G2 | N2 | `packages/retrieval/src/exegesis.ts`, `packages/retrieval/src/exegesis.test.ts` |
| N5 cross-refs-cte | hard | ts-impl | G2 | N2 | `packages/retrieval/src/cross-references.ts`, `packages/retrieval/src/cross-references.test.ts` |
| N6 compose-PgRetrieval + barrel | standard | ts-impl | G3 | N3,N4,N5 | `packages/retrieval/src/pg-retrieval.ts`, `packages/retrieval/src/pg-retrieval.test.ts`, `packages/retrieval/src/index.ts` |
| N7 eval-format + mock | standard | ts-impl | G1 | N1 | `packages/retrieval/eval/schema.ts`, `packages/retrieval/eval/perguntas-ouro.mock.jsonl`, `packages/retrieval/eval/README.md` |
| N8 eval-harness + gate *(GATE)* | hard | ts-impl | G4 | N6,N7 | `packages/retrieval/eval/harness.ts`, `packages/retrieval/eval/eval.test.ts` |
| N9 perguntas-ouro reais | standard | data-steward | G5 | N8 | `packages/retrieval/eval/perguntas-ouro.jsonl` (curadoria do dono) |

**Paralelismo (L2-lite quando ≥3 nós disjuntos prontos — ORCHESTRATION.md):**
`N1` → **{ N2 ∥ N7 }** → **G2 = { N3 ∥ N4 ∥ N5 }** → `N6` → `N8` → `N9`.
`N7` corre em paralelo a N2/G2 (só depende do port N1). `N6` é serial (compõe a classe + barrel —
ponto único de edição de `index.ts`, evita colisão com N2/G2). `N9` (data-steward, dado real) só
após o harness N8 verde no mock.

**Notas de disjunção:** N2 e N6 tocam `packages/retrieval/src/index.ts`, mas são **sequenciais**
(N2 cria o barrel mínimo; N6 é a única edição pós-G2) — sem colisão paralela. N3/N4/N5 têm arquivos
próprios e **não** tocam o barrel. N7/N8/N9 vivem em `packages/retrieval/eval/` — disjunto de `src/`.

### 6.1 Descrição por nó

- **N1 — port de exegese (core).** Enriquecer a operação de verso do `RetrievalService` para incluir
  `original_words` (⋈ `strongs`) e `interpretations` separadas (§3.1). **Muda um port âncora
  (ADR-008)** → só executa após o dono aprovar OQ-5 (o plano registra ADR-010). Sem I/O — só
  tipos/contrato + teste de contrato.
- **N2 — scaffold do pacote + cliente de embedding de query.** Cria `packages/retrieval` (deps:
  `@bereia/core`, `postgres@3.4.9`, `zod`), thin client HTTP para `/health`+`/embed` com trava de
  revisão ADR-005 (§2.4), barrel mínimo. Sem SQL de domínio ainda.
- **N3 — `searchByTheme`.** SQL de busca exata: hard filter no `WHERE` **antes** do ranking,
  `ORDER BY embedding <=> $q, id`, `translation`/`limit`, exclusão de `embedding IS NULL` (§3.2/§4).
- **N4 — exegese.** Lookup do verso + `verse_texts` + `original_words ⋈ strongs` + `interpretations`
  (linhas separadas, nunca fundidas), sob hard filter (§3.1).
- **N5 — cross-refs via recursive CTE.** Expansão em `edges` com `maxHops` limitado (OQ-2),
  **anti-ciclo**, ordem total determinística, hard filter nos versos alcançados (§3.3).
- **N6 — composição `PgRetrieval` + barrel.** Classe que implementa `RetrievalService` do core
  ligando N3/N4/N5 + o cliente N2; exporta pelo `index.ts`. Ponto único de fiação.
- **N7 — formato das perguntas-ouro + mock neutro.** Schema Zod da linha, fixture `*.mock.jsonl`
  placeholder **marcado como mock** (zero conteúdo teológico), README do formato/autoria (§5.1).
- **N8 — harness + snapshot tests (o GATE).** Carrega as perguntas-ouro, roda `PgRetrieval` contra
  Postgres real (`skipIf(!DATABASE_URL)` ou testcontainer, OQ-4), asserções de cobertura +
  determinismo + estabilidade de snapshot (§5.2). Verde no mock é o critério de merge do código;
  o gate teológico real usa N9.
- **N9 — perguntas-ouro reais (data-steward).** O dono cura queries + `expectedIds` reais (dado de
  `bereia-data`); o data-steward os grava e confirma o gate verde contra o Postgres carregado.
  Nunca inventar — só curadoria.

## 7. Verificação (por nó) — ADR-008

| Nó | Prova | Comando de aceite |
|---|---|---|
| N1 | Teste de contrato do port: shape de exegese inclui `originalWords`+`interpretations`; `interpretations` é array cru (fusão impossível pelo tipo); retrocompat dos demais métodos. | `pnpm --filter @bereia/core test && pnpm --filter @bereia/core typecheck` |
| N2 | Unit (client injetável, sem rede): `/health` com revisão divergente → explode (ADR-005); dimensão ≠1024 explode; `typecheck` do pacote novo. | `pnpm --filter @bereia/retrieval test -- embedder` |
| N3 | `skipIf(!DATABASE_URL)`: hard filter exclui verso não autorizado ANTES do ranking; SQL contém `ORDER BY embedding <=> $1, id`; mesma query 2× ⇒ IDs+ordem idênticos; `embedding NULL` não ranqueia. | `pnpm --filter @bereia/retrieval test -- search-theme` |
| N4 | `skipIf(!DATABASE_URL)`: verso inexistente → `null`; `originalWords` traz join de `strongs` (e `strongId=null` preservado); `interpretations` divergentes vêm separadas; hard filter aplicado. | `pnpm --filter @bereia/retrieval test -- exegesis` |
| N5 | `skipIf(!DATABASE_URL)`: `maxHops` limita profundidade; ciclo no grafo não laça (anti-ciclo); ordem de saída total e estável; verso não autorizado não vaza. | `pnpm --filter @bereia/retrieval test -- cross-references` |
| N6 | `PgRetrieval` satisfaz o tipo `RetrievalService` (typecheck); smoke das 3 operações pelo barrel; resolve por `@bereia/retrieval`. | `pnpm --filter @bereia/retrieval typecheck && pnpm --filter @bereia/retrieval test -- pg-retrieval` |
| N7 | Zod aceita o mock neutro; rejeita linha malformada; mock **sem** conteúdo teológico (marcado mock). | `pnpm --filter @bereia/retrieval test -- eval/schema` |
| N8 | `skipIf(!DATABASE_URL)`: cada pergunta-ouro do mock passa o critério de cobertura; determinismo (2× idêntico) verde; snapshot estável entre runs. | `pnpm --filter @bereia/retrieval test -- eval/eval` |
| N9 | Fontes/IDs conferidos contra `bereia-data`; gate verde com as perguntas reais contra o Postgres carregado; determinismo estável. | `DATABASE_URL=… pnpm --filter @bereia/retrieval test -- eval` |
| **Gate da fase** | Todos acima verdes + eval real (N9) aprovado + `pnpm gate` completo. | `pnpm gate` (com Postgres carregado por `load:postgres`) |

## 8. Fora de escopo (explícito)

- **Tools MCP reais (Fase 3):** o `mcp-server` continua MOCK; ligar `PgRetrieval` às 3 tools é Fase 3.
- **Geração/guardrails (Fase 4):** `HomileticGenerator`, validação de IDs citados, recusa fora de
  escopo — Fase 4. A Fase 2 só entrega o retrieval que a geração consumirá.
- **População de `passage_texts`** (perícope, ADR-003): fica vazia; só o eval justifica (OQ-8).
- **Índices de performance / FK real `original_words.strong_id`→`strongs`** (backlog Fase 1 §7):
  não são requisito de correção da Fase 2; entram por medição/decisão, não neste plano.
- **Curadoria/enriquecimento (Fase 5):** o reload DELETE+INSERT do N10 falha por FK quando
  `curation_log`/`reports`/`interpretations` tiverem linhas (backlog Fase 1 §7) — problema da Fase 5,
  não da Fase 2 (que só lê).

## 9. Questões em aberto — DECISÕES DO DONO (antes da execução)

- **OQ-1 (pacote do adapter):** aprovar `PgRetrieval` em **novo `packages/retrieval`** (deps
  `@bereia/core`+`postgres@3.4.9`), em vez de dentro de `ingestion` ou `mcp-server`? (default §2.1: sim).
- **OQ-2 (profundidade máxima do CTE):** teto de `maxHops` do `getCrossReferences`? Proposta:
  **teto = 3** (alinhado ao `maxHops ≤ 3` já hardcoded no stub do mcp-server e à §2 “Neo4j só se
  >3 saltos”), **default runtime = 1**. Confirmar.
- **OQ-3 (formato/autoria das perguntas-ouro):** aprovar `packages/retrieval/eval/perguntas-ouro.jsonl`
  com schema `{id, query, translation?, limit?, expectedIds[], note}`, **mock neutro no CI** e
  **conteúdo real curado pelo dono via data-steward** (N9)? (default §5.1: sim).
- **OQ-4 (onde o eval roda no gate):** `skipIf(!DATABASE_URL)` contra o Postgres do compose
  carregado por `load:postgres` (espelha N10), **ou** testcontainer efêmero? Proposta: **skipIf**
  agora; testcontainer é backlog. Confirmar.
- **OQ-5 (mudança do port `RetrievalService` — ESBARRA NA §5/âncora ADR-008):** aprovar enriquecer a
  operação de verso para exegese completa (`original_words ⋈ strongs` + `interpretations` separadas)?
  Renomear para `getExegesis` **ou** ampliar `getVerse`? A aprovação registra **ADR-010** (extensão
  do port + desfecho ADR-007 da §2.2). **Não decido aqui.**
- **OQ-6 (critério de aprovação do gate):** cobertura `expectedIds ⊆ topN` (com N por caso) **e/ou**
  exatidão de prefixo (`strict`) para casos marcados; qual N default? Proposta: N = `limit` do caso
  (default 10), `strict` opt-in por caso. Confirmar.
- **OQ-7 (cliente de embedding de query):** `retrieval` mantém **thin client próprio** (dup mínima do
  HTTP client de `ingestion`), ou **promover `EmbedderClient` compartilhado ao `core`**? Proposta:
  client próprio agora; refactor compartilhado é backlog. Confirmar.
- **OQ-8 (`passage_texts` vazia):** confirmar que a Fase 2 **não** popula perícopes (ADR-003) —
  `searchByTheme` só sobre `verse_texts` — e que déficit de recall no eval é o **gatilho documentado**
  para reabrir perícope, não trabalho especulativo agora? (default §2.5: sim).
- **OQ-9 (localização do schema Drizzle — desfecho ADR-007):** confirmar que o schema Drizzle
  **permanece no `core`** (contrato declarativo sem I/O; só `PgRetrieval` nasce fora)? Registrado em
  ADR-010 junto com OQ-5. (default §2.2: sim).
