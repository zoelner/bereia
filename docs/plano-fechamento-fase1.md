# Plano — Fechamento da Fase 1 (ingestão)

> Tudo o que falta entre os parsers prontos (USFX, TVTMS, STEPBible TAHOT/TAGNT) e o Postgres
> carregado: parser do dicionário Strong, parser de cross-references, gravação do JSONL canônico
> (FONTE DE VERDADE, no Git), embed batch e projeção Postgres.
> **Status: APROVADO** (2026-07-22) pelo dono, com desfecho das questões em aberto — OQ-6: coluna
> `edition` (nullable) em `original_words` via N0; OQ-3: todas as cross-refs carregadas sem voto;
> OQ-2: título v.0 gera linha indexável em `verse_texts`; OQ-1/4/5/7/8: defaults aceitos (JSONL
> por-tabela + partição por livro; descarte fora-do-cânon com estatística e teto ~0,5%;
> aramaico→`hebrew`; Strong 5-dígitos segue `null`+raw; `embeddingModel` = nome@revisão-HF).
> **Nota de execução (OQ-7 generalizado, N6):** o achado real incluiu também estendidos de **4 dígitos**
> G6xxx–G7xxx (71 lexemas / 363 palavras, acima do teto G5624 do dicionário openscriptures) — a mesma
> política se aplica: `strongId:null` + `strongRaw` preservado no BUILD; teste de FK real garante 0 não
> resolvidos. Backlog: dicionário estendido (stepbible §7).
> Contexto: CLAUDE.md §2/§5/§6/§7/§8, ADR-000/002/003/004/005/006/007/008,
> `docs/plano-stepbible.md` (§6 fora-de-escopo, §7 backlog).

## 1. Contexto e restrições

- **Determinismo é requisito de produto** (CLAUDE.md §1/§7). Aqui isso vale inclusive para a **ordem
  de linhas do JSONL**: mesma fonte pinada (`manifest.json` sha256) → mesmos arquivos byte a byte,
  `git diff` estável. Qualquer não-determinismo no retrieval — ou no dado que o alimenta — é bug.
- **Cadeia auditável (ADR-006):** manifest (hash pinado) → parsers determinísticos → **JSONL canônico
  (no Git)** → Postgres (projeção descartável). Embeddings derivados ficam **fora do Git**.
- **Versificação-mestre = KJV (ADR-002).** O conjunto de `canonical_id` é o inventário de versos da
  **KJV** (`eng-kjv`); BLIVRE/WEB entram por `toKjv` (mapper TVTMS, golden 100% verde). O STEPBible já
  entrega KJV embutida (desfecho `docs/plano-stepbible.md`). KJV é Textus Receptus, então versos só-TR
  (At 8:37, 1Jo 5:7 Comma, Rm 16:24) **existem** no cânon-mestre — alinham com BLIVRE (TR) e com o TAGNT
  `wordType` contendo `K`.
- **Identificadores EN (ADR-000):** os campos do JSONL são irreversíveis; nomes exatamente como o
  glossário e os schemas Zod do `core` (`canonicalId`, `strongId`, `strongRaw`, `authorizedLevels`, …).
- **Zod em toda fronteira; nada de `any`; explode cedo** (CLAUDE.md §7). Vocabulário fechado: notação ou
  código fora do observado nas fontes reais pinadas EXPLODE, nunca passa silencioso.
- **Testes ancorados em requisito (ADR-008):** números exatos atrelados ao sha256 do manifest; integração
  contra `data/sources/` com `skipIf(!existsSync)` (nunca verde falso); zero conteúdo teológico inventado
  (Strong IDs, refs e contagens são dados, não invenção).
- **Nenhuma decisão da §2 do CLAUDE.md é reaberta por este plano.** Um ponto **esbarra na §5** (schema) —
  o carimbo de edição em `original_words` — e está **PARADO em open question (OQ-6)**, não decidido aqui.

## 2. Formato real levantado (evidências)

### 2.1 Dicionário Strong (`data/sources/strongs/`, openscriptures, PD)

**Dois formatos heterogêneos** — o parser precisa de dois leitores distintos convergindo no mesmo
`strongsEntrySchema` do core (`{id, language, lemma, transliteration, definition}`):

- **Hebraico — `StrongHebrewG.xml` (OSIS)**, 8674 entradas (`<div type="entry">`), sha256
  `1f9659…`. Estrutura real:
  ```xml
  <div type="entry" n="1">
    <w gloss="4a" lemma="אָב" morph="n-m" POS="awb" xlit="ʼâb" ID="H1" xml:lang="heb">אב</w>
    <foreign xml:lang="grc"> <w gloss="G:1118"/> … </foreign>
    <list><item>1) father of an individual</item> …</list>
    <note type="exegesis">a primitive word;</note>
    <note type="explanation"><hi>father</hi>, in a literal…</note>
    <note type="translation">chief, (fore-) father(-less)…</note>
  </div>
  ```
  - `id` = atributo `ID` (`H1`, `H2`, …). **Sem sufixo de letra** no dado real (grep `ID="H\d+[a-z]"` → 0).
  - `lemma` = atributo `lemma` (hebraico apontado). `transliteration` = `xlit`.
  - `xml:lang` é `heb` OU **`arc` (aramaico)** — ambos na série H (ver OQ-5).
  - `definition` = composição determinística das `<list><item>` + `<note>` (ordem do documento).

- **Grego — `strongsgreek.xml` (DTD próprio)**, 5624 entradas (`<entry strongs=…>`), sha256 `df928f…`:
  ```xml
  <entry strongs="00001">
    <strongs>1</strongs> <greek BETA="*A" unicode="Α" translit="A"/> <pronunciation strongs="al'-fah"/>
    <strongs_derivation>of Hebrew origin;</strongs_derivation>
    <strongs_def> the first letter…</strongs_def><kjv_def>--Alpha.</kjv_def>
  </entry>
  ```
  - `id` = atributo `strongs` (`00001`, 5 chars zero-padded).
  - `lemma` = `<greek unicode>`; `transliteration` = `<greek translit>`.
  - `definition` = `strongs_derivation` + `strongs_def` + `kjv_def` (ordem do documento).

**Contrato de FK crítico (determinismo de join):** o `original_words.strongId` produzido pelo stepbible é
**4-dígitos zero-padded** (`SEGMENT_RE = /^([HG])(\d{4})([A-Z]?)$/` em `stepbible/strongs.ts` →
`H7225`, `G0976`, `H0430`). Portanto o dicionário DEVE emitir `id` na **mesma forma canônica
`/^[HG]\d{4}$/`** (`H0001`, `G0001`, `H8674`, `G5624`), não `H1`/`00001`. Máximos reais (8674 / 5624)
cabem em 4 dígitos. Isto é uma invariante entre nós, verificada por teste (OQ-6-b).

### 2.2 Cross-references (`data/sources/openbible-xrefs/cross_references.txt`, CC BY 4.0)

344.800 linhas (1 cabeçalho + **344.799 linhas de dado**); a proveniência é o zip pinado
`openbible-xrefs` (sha256 `9beb9c…`). Formato TSV:

```
From Verse	To Verse	Votes	#www.openbible.info CC-BY 2026-07-20
Gen.1.1	Ps.148.4-Ps.148.5	59
Gen.1.1	John.1.1-John.1.3	370
Gen.1.1	Exod.31.18	-38
Song.1.2	Gen.27.26-Gen.27.27	-1
```

Descobertas que moldam o parser:

- **Notação de livro = SBL/OSIS**, distinta de USFM E de TVTMS: `Gen`, `Ps`, `John`, `Exod`, `Prov`,
  `1Chr`, `Song`, `Joel`, `Obad`, `Phlm`, `Jude`, `3John`, `Rev`… Precisa de **tabela própria
  OpenBible→USFM** (vocabulário fechado, enumerado dos tokens reais do arquivo; token novo explode).
- **`From Verse`** é sempre um verso único. **`To Verse`** pode ser um **range** (`Ps.148.4-Ps.148.5`),
  inclusive **inter-capítulo** (evidência: linhas como `Exod.16.22-Exod.16.30`, `Ps.104.20-Ps.104.24`;
  ranges cruzando capítulo existem no corpus). Um range vira **uma `edge` por verso de destino**
  (edges são verso→verso, §5). Expandir range inter-capítulo exige o **inventário de versos da KJV**
  (lastVerse por capítulo) — reusar `usfxStandardInventory` da KJV; alternativa mais robusta: expandir
  **contra o conjunto de `canonical_id` já materializado** (N7 resolve e descarta o que não existe).
- **Versificação ALINHADA À KJV-mestre** (evidências): `Mal.4.*` presente (163 refs de origem) — a KJV
  tem Malaquias 4; **zero** refs a `.0` (títulos de Salmo não são referenciados — convenção inglesa, o
  corpo do Salmo começa em v.1, igual à KJV). **Consequência: cross-refs NÃO passam pelo mapper TVTMS**
  — só book-map + expansão de range. Diferenças residuais NRSV↔KJV do NT (2Co 13:14, 3Jo 1:14/15, Ap
  12:18/13:1, At 8:37) podem gerar endpoints que **não resolvem** contra `canonical_verses`; política =
  **descartar com estatística** sob limiar (OQ-4).
- **`Votes`** pode ser **negativo** (`-38`) — cross-ref disputada/downvotada. A tabela `edges` (§5) **não
  tem coluna de peso**; política de votos = OQ-3.

### 2.3 O que os parsers prontos já entregam (LIGAR, não reimplementar)

- `parseUsfx(xml) → UsfxBible` (`usfx/parser.ts`): versos NA versificação da fonte; `title` de capítulo =
  título de Salmo (`<d>`, texto canônico antes do v.1). `usfxSourceInventory`/`usfxStandardInventory`
  (`usfx/inventory.ts`) adaptam para o mapper.
- `toKjv(ref, tradition)` (`tvtms/mapper.ts`, golden verde): normaliza BLIVRE/WEB → KJV.
- `parseTahot`/`parseTagnt → TaggedWordRow[]` (`stepbible/`): `canonicalId` já KJV, `strongId` 4-díg.,
  `strongRaw`, `morphology`, `edition` (TextType/WordType cru).
- Schemas Zod e Drizzle no `core` (`schemas.ts`, `db/schema.ts`) — migration `0000_init.sql` já existe;
  os campos do JSONL são exatamente os schemas Zod.
- `embedder/main.py`: `POST /embed` (normalizado, `convert_to_numpy`), `GET /health` expõe
  `{model, revision}` (ADR-005), `HF_REVISION` pinada e obrigatória.

## 3. Decisão (abordagem)

### 3.1 Dois parsers Strong convergindo num normalizador de id compartilhado
Um leitor OSIS (hebraico) e um leitor do DTD grego, cada um mapeando para `strongsEntrySchema`. A
**forma canônica do id** (`/^[HG]\d{4}$/`, zero-padded) é imposta por um helper único e testada por
propriedade — é o que garante o join com `original_words.strongId`. `definition` é composta de forma
determinística (ordem do documento), preservando o conteúdo sem inventar nada. **Alternativa descartada:**
um parser XML genérico único — os dois formatos são estruturalmente incompatíveis (OSIS `<div>/<w>` vs
DTD `<entry>`), unificar aumentaria a superfície de erro sem ganho.

### 3.2 Cross-references: book-map + expansão de range, resolução contra o cânon materializado
O parser produz pares `(fromUsfm.c.v, toUsfm.c.v)`; a **resolução** para `canonical_id` e o **descarte
com estatística** de endpoints inexistentes acontecem no nó de edges (N7), que já tem o conjunto de
`canonical_id` da KJV em mãos — evita duplicar o inventário e centraliza a política OQ-4. Não usa TVTMS
(evidência §2.2). **Alternativa descartada:** rotear cross-refs pelo mapper TVTMS — a versificação já é
KJV; o mapper só adicionaria risco.

### 3.3 JSONL canônico: layout, ordem determinística, política de verso 0
- **Layout (proposta, OQ-1):** um arquivo por tabela em `data/canonical/`, **exceto** as duas tabelas
  grandes por-verso, particionadas por livro para localidade de `git diff`:
  ```
  data/canonical/
    canonical_verses.jsonl          # ~31k linhas (inventário KJV-mestre)
    verse_texts/{BOOK}.jsonl         # ~31k × ≤3 traduções, particionado por livro
    original_words/{BOOK}.jsonl      # ~470k linhas (TAHOT+TAGNT), particionado por livro
    strongs.jsonl                    # 8674 H + 5624 G = 14.298 linhas
    edges.jsonl                      # cross-refs kind 'tsk'
    BUILD_MANIFEST.json              # contagens por arquivo (âncora ADR-008)
  ```
- **Ordem determinística (regra global):** ordem canônica de livro (`USFM_BOOKS` do `core`) → chapter →
  verse → (para `verse_texts`: `translation` asc; para `original_words`: `position` asc). `strongs`
  ordenado por `(language, id)`; `edges` por `(sourceId canônico, targetId canônico, kind)`. Chaves de
  ordenação totais e estáveis → `git diff` mínimo entre builds.
- **Campos por linha** = exatamente os schemas Zod (ADR-000), validados na gravação:
  - `canonical_verses`: `{id, book, chapter, verse, canonStatus:"protestant", theologicalCategory:null}`.
  - `verse_texts`: `{canonicalId, translation, text, embeddingModel:null, thematicTags:[],
    culturalContext:null, humanReviewed:false, reviewedBy:null, authorizedLevels:["public"]}`.
    **`embedding` NÃO entra no JSONL canônico** (é derivado, fora do Git — ADR-006).
  - `original_words`: `{canonicalId, position, lexeme, strongId, strongRaw, morphology}`
    (+ `edition` **se** OQ-6 aprovar a coluna).
  - `strongs`: `{id, language, lemma, transliteration, definition}`.
  - `edges`: `{sourceId, targetId, kind:"tsk"}`.
- **Verso 0 / título de Salmo (proposta, OQ-2):** quando a KJV tem título (`UsfxChapter.title`),
  emitir a linha `PSA_x_0` em `canonical_verses` **e** o texto do título em `verse_texts` (por tradução
  que o tenha) — coerente com `canonicalVerseSchema.verse` nonnegative e com o STEPBible (título = v.0).
  Assim o título é indexável e citável por ID.

### 3.4 Embed batch: carimbo de revisão + trava + hash de regressão (ADR-005)
Lê `verse_texts/*.jsonl`, envia em lotes ao sidecar, grava `data/derived/embeddings-{model_rev}.jsonl`
(`{canonicalId, translation, embedding, embeddingModel}`) fora do Git. Antes de rodar: `GET /health`, e
**aborta** se a revisão divergir do esperado. `embeddingModel` = carimbo `"${MODEL_NAME}@${HF_REVISION}"`
(OQ-8). Teste de regressão: hash de vetores de um conjunto fixo pequeno de versos (âncora do build).
Ordem determinística idêntica à do `verse_texts`.

### 3.5 Load Postgres: projeção idempotente via Drizzle
Lê os JSONL canônicos + o derivado de embeddings e projeta nas tabelas (`0000_init.sql` já existe).
Ordem de carga respeitando FK: `canonical_verses` → `verse_texts` (join do embedding por
`canonicalId+translation`) → `strongs` → `original_words` → `edges`. Idempotente (truncate+insert
transacional ou upsert). Metadados do hard filter conforme §5 (`canonStatus`, `authorizedLevels`).
Cross-check de integridade referencial ao final.

## 4. Decomposição em nós

`scope.paths` disjuntos entre nós do mesmo grupo paralelo. Comando base:
`pnpm --filter @bereia/ingestion test` (+ `typecheck`); cada nó prova-se por ADR-008.

| Nó | Tier | Agente | Grupo | Depende | Escopo (arquivos) |
|---|---|---|---|---|---|
| N0 schema-edition *(condicional OQ-6)* | standard | ts-impl | G0 | — | `core/src/schemas.ts`, `core/src/db/schema.ts`, `core/drizzle/0001_original_words_edition.sql` |
| N1 strongs-dict | hard | ts-impl | P1 | — | `parsers/strongs/hebrew.ts`, `parsers/strongs/greek.ts`, `parsers/strongs/index.ts`, `parsers/strongs/strongs.test.ts` |
| N2 xrefs | hard | ts-impl | P1 | — | `parsers/xrefs/books.ts`, `parsers/xrefs/parser.ts`, `parsers/xrefs/index.ts`, `parsers/xrefs/xrefs.test.ts` |
| N4 load-core | standard | ts-impl | P1 | — | `load/order.ts`, `load/jsonl.ts`, `load/order.test.ts` |
| N3 wire-parsers | trivial | ts-impl | S1 | N1,N2 | `packages/ingestion/src/index.ts` |
| N5 build-verses | hard | ts-impl | P2 | N4 | `load/verses.ts`, `load/verses.test.ts` |
| N6 build-words | hard | ts-impl | P2 | N4,N1,N3 (,N0) | `load/words.ts`, `load/words.test.ts` |
| N7 build-edges | hard | ts-impl | S2 | N4,N2,N5 | `load/edges.ts`, `load/edges.test.ts` |
| N8 build-canonical | standard | ts-impl | S3 | N5,N6,N7 | `load/build-canonical.ts`, `load/build-manifest.ts`, `packages/ingestion/package.json` |
| N9 embed-batch | hard | ts-impl | P3 | N5 | `load/embed.ts`, `load/embed.test.ts`, `packages/ingestion/package.json`※ |
| N10 load-postgres | hard | ts-impl | S4 | N8,N9 | `load/postgres.ts`, `load/postgres.test.ts` |
| N11 run-canonical | standard | data-steward | S5 | N8 | `data/canonical/**` (fonte de verdade, no Git) |

Paralelismo: **P1 = {N1 ∥ N2 ∥ N4}** → **N3** → **P2 = {N5 ∥ N6}** → **N7** → **N8**; **N9** roda após
N5 (paralelo a S2/S3); **N10** após N8+N9; **N11** (data-steward) após N8 com todos os gates verdes.
**N0** só existe se OQ-6 for aprovada, e antecede N6.

※ N8 e N9 tocam `package.json` (scripts). Se rodarem no mesmo grupo, serializar o edit desse arquivo ou
concentrar todos os scripts em N8; como N9 está em grupo distinto (P3, após N8 na ordem de merge), sem
colisão real — registrado para o orquestrador.

### Descrição por nó

- **N0 (condicional) — coluna `edition` em `original_words`.** Só se OQ-6 aprovar preservar o carimbo:
  adiciona `edition` (nullable) a `originalWordSchema` + `original_words` + migration `0001`. Toca §5 do
  schema — **decisão do dono**, não tomada aqui.
- **N1 — parser do dicionário Strong.** OSIS (hebraico) + DTD (grego) → `StrongsEntry[]`, id na forma
  canônica `/^[HG]\d{4}$/`. Aramaico (`arc`) na série H com `language:"hebrew"` (OQ-5). Vocabulário
  fechado; tag/atributo inesperado explode.
- **N2 — parser das cross-references.** `books.ts` = mapa OpenBible→USFM (enumerado dos tokens reais).
  `parser.ts` = TSV → pares `(from, to)` com expansão de range (intra e inter-capítulo, delegando a
  resolução inter-capítulo ao conjunto canônico em N7). Votos lidos e sujeitos a OQ-3.
- **N4 — núcleo de load.** `order.ts` (ordem canônica total e estável) + `jsonl.ts` (writer
  determinístico, newline-terminated, sem dependência de I/O de rede). Fundação dos nós de build.
- **N3 — fiação.** Exporta os barrels `strongs`/`xrefs` de `ingestion/src/index.ts`. Sem lógica.
- **N5 — build de `canonical_verses` + `verse_texts`.** Inventário KJV-mestre (identidade); BLIVRE/WEB
  via `toKjv`. Política de verso 0 (§3.3/OQ-2). Zod na gravação; ordem determinística.
- **N6 — build de `original_words` + `strongs`.** Junta `parseTahot`/`parseTagnt` (words) e N1 (dict).
  **Cross-check de FK:** todo `strongId` lexical ∈ `strongs.jsonl` (exceto os 5-díg. estendidos, que
  ficam `strongId:null` + `strongRaw` — backlog stepbible §7). Carimbo `edition` só se OQ-6/N0.
- **N7 — build de `edges`.** Resolve os pares de N2 contra o conjunto de `canonical_id` de N5; expande
  ranges inter-capítulo; descarta endpoints inexistentes **com estatística** sob limiar (OQ-4); remove
  self-loops; ordem determinística. `kind:"tsk"`.
- **N8 — CLI `build:canonical`.** Orquestra N5/N6/N7, grava `data/canonical/*.jsonl` + `BUILD_MANIFEST.json`
  (contagens = âncoras ADR-008); re-run byte-idêntico.
- **N9 — embed batch.** §3.4: trava por revisão (ADR-005), hash de regressão, grava
  `data/derived/embeddings-{rev}.jsonl` (fora do Git).
- **N10 — load Postgres.** §3.5: projeção idempotente via Drizzle, integridade referencial, metadados
  do hard filter.
- **N11 (data-steward) — geração do dado canônico.** Roda `build:canonical` com as fontes pinadas
  (confere sha256 do manifest), **commita `data/canonical/*.jsonl`** (a fonte de verdade), confirma que
  as contagens batem `BUILD_MANIFEST` e que o re-run dá `git diff` vazio.

## 5. Verificação (por nó) — ADR-008

| Nó | Prova | Comando de aceite |
|---|---|---|
| N0 | `originalWordSchema` aceita `edition` nullable; migration aplica coluna; retrocompat. | `pnpm --filter @bereia/core test && pnpm --filter @bereia/core typecheck` |
| N1 | `skipIf`: **8674** entradas H + **5624** G (atrelado ao sha256); toda saída casa `/^[HG]\d{4}$/`; amostras ancoradas (`H1`→`H0001` lemma `אָב`; `G0001`→`Α`). | `pnpm --filter @bereia/ingestion test -- parsers/strongs` |
| N2 | `skipIf`: **344.799** linhas parseadas; book-map cobre TODOS os tokens reais; range `Ps.148.4-Ps.148.5`→2 pares; voto negativo preservado até OQ-3; token/notação nova explode. | `pnpm --filter @bereia/ingestion test -- parsers/xrefs` |
| N4 | Unit (mock sintético): ordenação canônica estável e total; writer idempotente byte a byte; roundtrip Zod. | `pnpm --filter @bereia/ingestion test -- load/order` |
| N3 | `typecheck` + `parseStrongsDict`/`parseXrefs` resolvem pelo barrel. | `pnpm --filter @bereia/ingestion typecheck` |
| N5 | `skipIf`: nº de versos = inventário KJV; BLIVRE/WEB mapeados por `toKjv`; caso-ouro de verso 0 (título de Salmo) presente conforme OQ-2; Zod 100%. | `pnpm --filter @bereia/ingestion test -- load/verses` |
| N6 | `skipIf`: nº de `original_words` (âncora manifest); **todo `strongId` lexical resolve em `strongs.jsonl`**; 5-díg. estendidos → `null`+`strongRaw`; 0 deuterocanônico. | `pnpm --filter @bereia/ingestion test -- load/words` |
| N7 | `skipIf`: edges resolvidas contra `canonical_verses`; taxa de descarte < limiar OQ-4 (falha ruidosa acima); 0 self-loop; caso-ouro `Gen.1.1→John.1.1..3`. | `pnpm --filter @bereia/ingestion test -- load/edges` |
| N8 | `build:canonical` grava os JSONL + `BUILD_MANIFEST.json`; re-run → `git diff` vazio (determinismo). | `pnpm --filter @bereia/ingestion build:canonical && git diff --exit-code data/canonical` |
| N9 | `skipIf(no embedder)`: `/health` revisão == esperada senão aborta; hash de regressão de conjunto fixo bate; dimensões=1024; ordem determinística. | `pnpm --filter @bereia/ingestion test -- load/embed` |
| N10 | `skipIf(no DATABASE_URL)`/testcontainer: projeção idempotente; FK íntegra (`original_words`→`strongs`, `edges`→`canonical_verses`); `authorizedLevels`/`canonStatus` corretos. | `pnpm --filter @bereia/ingestion test -- load/postgres` |
| N11 | Fontes conferidas por sha256; contagens == `BUILD_MANIFEST`; `git diff` estável no re-run. | `git status data/canonical` (dado commitado) |

## 6. Questões em aberto — DECISÕES DO DONO

- **OQ-1 (layout JSONL):** aprova um arquivo por tabela, com `verse_texts` e `original_words`
  particionados por livro (`{BOOK}.jsonl`), e `strongs`/`edges` em arquivo único? (default proposto §3.3).
- **OQ-2 (verso 0 / título de Salmo em `verse_texts`):** emitir o texto do título como linha
  `verse_texts` (indexável/embedado), além da linha estrutural em `canonical_verses`? (default: sim).
- **OQ-3 (votos das cross-refs):** `edges` (§5) não tem coluna de peso. Descartar votos e carregar TODAS
  as edges (inclusive voto negativo — determinismo, curadoria depois)? Ou aplicar limiar fixo
  (ex.: `votes > 0`)? Ou **adicionar coluna de peso** (toca §5)? (default: carregar todas, votos
  descartados; peso vira backlog).
- **OQ-4 (endpoints fora do cânon-mestre):** edges cujo destino não existe em `canonical_verses`
  (diferenças NRSV↔KJV do NT, versos ausentes) são **descartadas com estatística** — confirmar a política
  e o **limiar de taxa de descarte** que faz o build falhar (proposta: falhar se > ~0,5% dos endpoints).
- **OQ-5 (Strong aramaico):** entradas `xml:lang="arc"` da série H recebem `language:"hebrew"` (o enum do
  schema é `hebrew`|`greek`; a série H é a chave)? (default: sim).
- **OQ-6 (carimbo de edição em `original_words` — ESBARRA NA §5):** o `TaggedWordRow.edition`
  (TextType/WordType, decisão Q4 do stepbible "carregar tudo carimbado, projeção decide") **não tem
  coluna** em `original_words`. Sem ela, perde-se o filtro TR (`K ∈ wordType`) que distingue palavras
  só-TR (Rm 16:24, 2Co 13:14) das só-NA. **Não decido aqui.** Opções: (a) adicionar coluna `edition`
  nullable (N0 — evolução de schema via ADR, não reabertura de §2); (b) projetar só TR no load (lossy);
  (c) manter só `strongRaw`/`morphology` e adiar. Recomendação: (a). Sub-item **OQ-6-b:** congelar a
  forma canônica do `strong_id` como `/^[HG]\d{4}$/` (zero-padded) — o `strongsEntrySchema` hoje aceita
  `\d{1,4}`; proponho apertar o **uso** (não o schema) e testar o join. Confirmar.
- **OQ-7 (Strong estendido 5-díg.):** G20447/G20833 etc. (stepbible §7) ficam `strongId:null` +
  `strongRaw` (FK-safe, sem entrada no dicionário) — confirmar que seguem assim no fechamento.
  *Desfecho na execução (N6):* generalizado para TODO Strong grego fora do dicionário openscriptures
  (inclui estendidos de 4 dígitos G6xxx–G7xxx, 71 lexemas/363 palavras) — `strongId:null` + `strongRaw`,
  validado por teste de FK contra o dicionário real.
- **OQ-8 (carimbo `embeddingModel`):** formato `"${MODEL_NAME}@${HF_REVISION}"` (ex.: `BAAI/bge-m3@<rev>`),
  usado em `verse_texts`/derived/Postgres e na trava ADR-005 — confirmar a string exata.
