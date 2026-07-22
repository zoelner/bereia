# Plano — Parser TSV do STEPBible (TAHOT + TAGNT)

> Próximo passo da Fase 1: extrair palavras originais (hebraico/grego) tageadas com Strong e
> morfologia dos arquivos amalgamados do STEPBible (CC BY 4.0), alinhando cada palavra ao
> `canonical_id` mestre (KJV). Alimenta `original_words` e, via `openscriptures/strongs`, `strongs`.
> Status: **APROVADO** (2026-07-22) pelo dono, com as quatro decisões: (Q1) produtor do
> `canonical_id` = ref KJV embutida, mapper TVTMS como gate independente; (Q2) preservar o
> dStrong bruto em campo extra de `original_words` (§5 ganha a coluna — ex.: `strong_raw`);
> (Q3) At 8:37: N4 investiga empiricamente e trava caso-ouro; (Q4) variantes (Ketiv/Qere,
> leituras minúsculas) carregadas todas com carimbo — a projeção decide exposição.
> Contexto: CLAUDE.md §2/§5/§7, ADR-001, ADR-002, ADR-006, ADR-008, `docs/spike-tvtms.md`.

## 1. Contexto e restrições

- **Determinismo é requisito de produto**: mesma fonte pinada (sha256 no `manifest.json`) → mesmos
  `original_words`, sempre. Qualquer ref ambígua explode cedo (vocabulário fechado, padrão de
  `usfx/` e `tvtms/`).
- **Versificação-mestre = KJV** (ADR-002). O erro aqui contamina `canonical_id` sistematicamente,
  então a versificação tem gate próprio de casos-ouro.
- **Identificadores EN** (ADR-000); `strong_id` obedece `/^[HG]\d{1,4}$/` (`strongsEntrySchema` do core).
- **Cânon de 66** (CLAUDE.md §2): deuterocanônicos reconhecidos e **pulados com estatística**, nunca
  parseados (mesmo tratamento do `tvtms/books.ts`).
- **Fontes fora do Git** (ADR-006): testes de integração fazem `skipIf(!existsSync)`, nunca verde falso;
  números exatos atrelados ao sha256 do manifest (ADR-008).
- Reaproveitar o que já existe: o mapper TVTMS (`toKjv`, golden 100% verde), a interface
  `SourceInventory`, a tabela de códigos USFM. **Nenhuma decisão da §2 é reaberta por este plano.**

## 2. Formato real levantado (evidências)

Arquivos: 4× TAHOT (`Gen-Deu`, `Jos-Est`, `Job-Sng`, `Isa-Mal`) e 2× TAGNT (`Mat-Jhn`, `Act-Rev`),
`stepbible-tahot`/`stepbible-tagnt` no manifest (commit `0f60797…`). Cada arquivo tem ~40–70 linhas de
cabeçalho/licença, depois blocos por verso: uma linha interlinear-resumo por verso prefixada `#`
(`# Gen.1.1  …`) e — o que nos interessa — **uma linha TSV por palavra original**.

### 2.1 TAHOT (AT hebraico) — linha por palavra

```
Gen.1.1#01=L⇥בְּ/רֵאשִׁ֖ית⇥be./re.Shit⇥in/ beginning⇥H9003/{H7225G}⇥HR/Ncfsa⇥…⇥H7225G⇥…⇥H9003=ב=in/{H7225G=רֵאשִׁית=…}
```

| Col | Conteúdo | Exemplo |
|---|---|---|
| 1 | `Ref#pos=TextType` | `Gen.1.1#01=L` |
| 2 | Hebraico apontado (com `/` separando prefixos/sufixos do radical, `\` pontuação) | `בְּ/רֵאשִׁית` |
| 3 | Transliteração | `be./re.Shit` |
| 4 | Glosa inglesa | `in/ beginning` |
| 5 | **dStrong** (prefixo `H9xxx` + radical em `{…}`, com letra de desambiguação) | `H9003/{H7225G}` |
| 6 | **Morfologia** (ETCBC/OpenScriptures) | `HR/Ncfsa` |
| 9 | sStrong+Instance (Strong "simples" já sem letra BDB) | `H7225G` |
| 12 | Expanded Strong tags (radical + glosa) | `H9003=ב=in/{H7225G=…}` |

Descobertas que moldam o parser:

- **A referência primária JÁ É INGLESA/KJV, não hebraica.** O cabeçalho diz "as defined by the NRSV",
  mas o dado real é KJV-alinhado: Malaquias tem capítulo 4, Joel tem 3 capítulos, título de Salmo é v.0.
  A **referência hebraica vem em parênteses redondos quando difere**:
  - `Psa.3.0(3.1)` — inglês v.0 (título); hebraico conta o título como v.1.
  - `Mal.4.1(3.19) … Mal.4.6(3.24)` — inglês tem cap. 4; hebraico não (fica em 3.19–24).
  - `Jol.2.28(3.1)`, `Jol.3.1(4.1)` — inglês 3 caps.; hebraico 4.
  Quando não há parênteses, hebraico == inglês. **Consequência: o KJV ref sai de graça na coluna 1**;
  o hebraico serve para o gate de versificação (§4).
- **`#pos`** = posição da palavra no verso (`#01`, `#02`…), zero-padded. `verse 0` = título de Salmo.
- **`=TextType`** = fonte do texto: `L`=Leningrad, `Q`=Qere, `K`=Ketiv, `R`=restaurado, `X`=reconstruído
  do LXX, etc. Vocabulário fechado a validar; variantes (Ketiv etc.) precisam de política (§3.4).
- **dStrong (col 5)** mistura três coisas: tags de gramática `H9xxx` (prefixos/sufixos/pontuação — **não
  são Strong lexical**, ≥9000), o **radical** em `{…}`, e letra de desambiguação (`H7225G`, `H0430G`).
  Precisa normalização para `/^[HG]\d{1,4}$/` (§3.2).

### 2.2 TAGNT (NT grego) — linha por palavra

```
Mat.1.1#01=NKO⇥Βίβλος (Biblos)⇥[The] book⇥G0976=N-NSF⇥βίβλος=book⇥NA28+NA27+Tyn+SBL+WH+Treg+TR+Byz⇥…
```

| Col | Conteúdo | Exemplo |
|---|---|---|
| 1 | `Ref#pos=WordType` | `Mat.1.1#01=NKO` |
| 2 | Grego (transliteração) | `Βίβλος (Biblos)` |
| 3 | Glosa inglesa | `[The] book` |
| 4 | `dStrong=Grammar` | `G0976=N-NSF` |
| 5 | Forma de dicionário `=` glosa | `βίβλος=book` |
| 6 | **Edições** (lista `+`) | `NA28+NA27+Tyn+SBL+WH+Treg+TR+Byz` |
| 12 | sStrong+Instance | `G0976` |

Descobertas:

- **A referência primária é NRSV; o KJV vem em colchetes retos `[…]`** (parênteses redondos = NA,
  chaves = outros). Ex.: `2Co.13.13[13.14]`, `3Jn.1.15[1.14]`. Onde não há colchete, NRSV == KJV.
  **Consequência: o KJV ref sai da coluna 1 lendo o colchete reto** (fallback = ref primária).
- **`=WordType`** é o marcador de edição por palavra: `N`=NA (Nestlé-Aland), `K`=KJV/Scrivener 1894 (**=TR**),
  `O`=outro grego. Maiúscula = presença firme; minúscula/entre-parênteses = presença como variante.
  Distribuição real (Mat-Jhn): `NKO` 62 091, `N(k)O` 1 354, `k` 885, `K` 707, `KO` 572, `no` 336, … .
  Ex.: `Rom.16.24#01=KO` — palavra em TR+Outro mas **não em NA** (o verso TR-only ausente nos críticos);
  `2Co.13.13[13.14]#22=K` — as palavras da bênção final que só o TR/KJV têm.
- **Col 6 (Edições)** é a lista precisa e redundante ao WordType: `TR` presente ⇔ WordType contém `K`.
  Serve de checagem cruzada.
- **dStrong (col 4)** é limpo (`G0976`), sem prefixos `H9xxx`, mas pode ter letra de desambiguação.

### 2.3 A marcação de edições e o MVP (TR vs NA)

BLIVRE e KJV são **Textus Receptus** (CLAUDE.md §3). No TAGNT, o texto TR é exatamente o conjunto de
palavras cujo `WordType` contém `K`. Portanto o parser não precisa "escolher uma edição inteira": ele
carrega **toda** palavra e carimba `edition`/`wordType`, e o filtro TR é uma projeção (`K ∈ wordType`).
Casos de fronteira reais que o filtro precisa acertar:

| Caso | Evidência TAGNT | Efeito no TR |
|---|---|---|
| Rom 16:24 | `Rom.16.24#0x=KO` (sem `N`) | verso existe no TR/KJV, ausente no NA |
| 2Co 13:14 | `2Co.13.13[13.14]#21-33=K` | bênção final é v.14 no KJV; palavras só-TR |
| Comma/2Co/etc. | palavras `K`/`k` isoladas | pertencem ao TR |
| **At 8:37** | **`Act.8.37` não aparece como ref** (só 8.35, 8.36) | **precisa de verificação — §7** |

## 3. Decisão (abordagem)

### 3.1 Versificação: ler o KJV que o STEPBible já embute; validar com o mapper TVTMS

O levantamento corrige a premissa da tarefa ("TAHOT usa versificação hebraica"): **o STEPBible já entrega
a referência KJV embutida** — na coluna 1 do TAHOT (primária) e no colchete reto do TAGNT. Decisão:

- **Produtor do `canonical_id`** = o KJV ref lido do próprio dado:
  - TAHOT → ref primária (col 1), que é KJV-alinhada (Mal 4, Joel 3 caps., título v.0).
  - TAGNT → colchete reto `[KJV]` quando presente, senão a ref primária (NRSV==KJV).
- **Gate de verificação** = o mapper TVTMS (`toKjv`, golden 100% verde) roda como **checagem cruzada
  independente** sobre o TAHOT: constrói-se um `SourceInventory` **hebraico real** a partir das linhas-por-
  palavra (contagem de palavras por verso, existência, último verso, título) e afirma-se
  `toKjv(refHebraico, tradition:"Hebrew") == refPrimáriaKJV` nos livros que divergem (títulos de Salmos,
  Ml 4, Jl 2–3). É o **primeiro exercício REAL dos Renumber** que a tarefa pede — hoje só simulação cobre —,
  agora contra **contagens de palavras reais** (o teste `Mal.3` do TVTMS decide a tradição por contagem).

Por que produtor = ref embutida, e não o mapper:
- **Mais determinístico**: ler um campo é mais robusto que re-derivar via avaliação de Tests.
- **Consistente com ADR-002 no espírito**: o KJV ref do STEPBible é derivado das MESMAS tradições TVTMS
  (mesma casa, Tyndale House). Não estamos inventando normalização — consumimos a normalização do STEPBible
  e a **verificamos** contra nosso mapper independente. Se divergirem num caso-ouro, o gate explode **antes**
  de gravar JSONL — que é a garantia que o ADR-002 exige.
- **Menor superfície de falha**: o mapper não vira dependência de runtime da ingestão TAHOT; só de teste.

**Alternativas descartadas:**
- *(A) Mapper como produtor (Hebrew→KJV) para TAHOT.* Fiel à letra do ADR-002, mas redundante (o KJV já
  está no dado), acopla a produção à avaliação de Tests e ao inventário, e a equivalência com a ref
  embutida teria de ser assumida em vez de verificada. Mantido como opção caso o dono prefira a letra do
  ADR (open question Q1).
- *(B) Rotear TAGNT pelo mapper TVTMS (grego).* As tradições gregas do TVTMS (`Greek`/`Greek2`/
  `GreekUndivided`/…) não estão validadas pelo golden, e as diferenças NRSV↔KJV do NT são um conjunto
  fechado e pequeno já marcado no colchete. Baixo valor, risco alto. Descartado; assimetria (TAHOT tem gate
  de mapper, TAGNT não) registrada em Q1.

### 3.2 Strong: normalizar dStrong → Strong lexical simples

Um normalizador único para as duas fontes: recebe o campo dStrong e devolve `strong_id` em
`/^[HG]\d{1,4}$/` ou `null`.
- TAHOT: extrai o **radical** de `{…}` (ignora tags `H9xxx` de prefixo/sufixo/pontuação e o prefixo antes
  da `/`); remove a letra de desambiguação (`H7225G`→`H7225`); mantém o zero-padding a 4 dígitos.
- TAGNT: usa o dStrong (col 4, antes do `=`); remove letra de desambiguação.
- Explode se, após limpar, sobrar algo fora do padrão (vocabulário fechado). A **letra de desambiguação e as
  tags de prefixo/sufixo se perdem** no `strong_id` (que aponta para o dict openscriptures, plano 4 dígitos)
  — perda consciente; a string dStrong bruta pode ser preservada em `morphology`/campo cru (Q2).

### 3.3 Modelo de saída (contrato `TaggedWordRow`)

Uma linha TAHOT/TAGNT = uma palavra ortográfica = **uma `TaggedWordRow`** (evolui o schema atual de
`stepbible.ts`):
`{ canonicalId, position, lexeme, strongId (root normalizado | null), morphology (col grammar cru),
edition (TAGNT: WordType; TAHOT: TextType), … }`. Mantém `parseTahot`/`parseTagnt` como **ports públicos**
(âncora ADR-008) — assinaturas preservadas, implementação movida para `stepbible/`.

### 3.4 Vocabulário fechado a fixar (explodir cedo)

- Códigos de livro STEPBible → USFM: idênticos aos do `tvtms/books.ts` (`Psa`, `Mal`, `Jol`, `3Jn`, `2Co`,
  `Sng`, …). **Reusar a tabela do TVTMS**; teste-fixture enumera TODO código presente nos 6 arquivos reais.
- `TextType` do TAHOT (`L/Q/K/R/X/…`) e `WordType` do TAGNT (`N/K/O` maiúsc./minúsc./parênteses):
  enums Zod fechados; qualquer código novo explode.

## 4. Decomposição em nós

Diretório novo `packages/ingestion/src/parsers/stepbible/` (espelha `tvtms/`); o atual
`parsers/stepbible.ts` vira barrel no fim (N6). `scope.paths` disjuntos entre nós paralelos.

| Nó | Tier | Agente | Arquivos (scope) | Depende |
|---|---|---|---|---|
| N1 refs+tipos | hard | ts-impl | `stepbible/types.ts`, `stepbible/refs.ts`, `stepbible/refs.test.ts` | — |
| N2 strongs | standard | ts-impl | `stepbible/strongs.ts`, `stepbible/strongs.test.ts` | — |
| N3 TAHOT | hard | ts-impl | `stepbible/tahot.ts`, `stepbible/tahot.test.ts` | N1, N2 |
| N4 TAGNT | hard | ts-impl | `stepbible/tagnt.ts`, `stepbible/tagnt.test.ts` | N1, N2 |
| N5 gate versificação | hard | ts-impl | `stepbible/versification-gate.test.ts` | N1, N3 |
| N6 barrel+wire | trivial | ts-impl | `stepbible/index.ts`, `stepbible.ts`, `parsers/*` barrel | N3, N4 |

Paralelismo: **N1 ∥ N2**; depois **N3 ∥ N4**; depois **N5** (após N3) e **N6** (após N3+N4).

### N1 — Parser de referência + tipos (`refs.ts`, `types.ts`)
Parseia col 1 das duas fontes num tipo comum. TAHOT: `Ref(HebRef)#pos=TextType` → `{ book (USFM),
chapter, verse, position, textType, hebRef?: {chapter,verse} }`. TAGNT: `Ref[KjvRef](NaRef){Other}#pos=WordType`
→ `{ book, nrsv:{chapter,verse}, kjv?:{chapter,verse}, position, wordType }`. Livro via tabela USFM (reuso
TVTMS); deuterocanônico → sinaliza skip. `types.ts` guarda `taggedWordRowSchema` (evoluído) + enums
`textType`/`wordType`. Vocabulário fechado, explode em código/notação desconhecida.

### N2 — Normalizador de Strong (`strongs.ts`)
`normalizeStrong(dStrong, lang): string|null` conforme §3.2. Unitário com strings dStrong reais (são
códigos, não conteúdo teológico): `H9003/{H7225G}`→`H7225`, `H0430G`→`H0430`, `{H0853}`→`H0853`, `G0976`→
`G0976`, tags só-`H9xxx`→`null`. Garante saída `/^[HG]\d{1,4}$/` (casa `strongsEntrySchema`).

### N3 — Parser TAHOT (`tahot.ts`)
`parseTahot(tsv) → TaggedWordRow[]`, consumindo os 4 arquivos. Usa N1 (ref) + N2 (strong). `canonicalId` =
ref primária KJV. `edition` = TextType. Pula deuterocanônico com estatística. **Exporta também um builder de
`SourceInventory` hebraico** (contagem de palavras por HebRef, existência, último verso, `hasTextBeforeV1`
na convenção hebraica — título é v.1) para N5. Assertivas de número exatas atreladas ao sha256 do manifest;
`skipIf(!existsSync)`.

### N4 — Parser TAGNT (`tagnt.ts`)
`parseTagnt(tsv) → TaggedWordRow[]`, 2 arquivos. `canonicalId` = KJV do colchete reto (fallback primária).
`edition`/`wordType` carimbado por palavra; helper de projeção TR (`K ∈ wordType`). Casos-ouro de fronteira:
Rom 16:24 (`KO`, só-TR), 2Co 13:14 (bênção `K`), Rev 12:18/13:1, 3Jn 1:14. **At 8:37 verificado explicitamente**
(Q3). Assertivas de número atreladas ao manifest; `skipIf`.

### N5 — Gate de versificação (cross-check TVTMS × TAHOT real)
Teste de integração: carrega TVTMS (`loadTvtms`) com o `SourceInventory` hebraico REAL do N3 e compara
`toKjv(hebRef,"Hebrew")` com o conjunto de canonical_ids da ref embutida, verso a verso (23.213), inclusive
títulos de Salmos, Ml 3.19-24→4.1-6 e Jl 3-4→2.28-3.21. `skipIf(!existsSync)`. **É o gate ADR-002 para o
TAHOT: nenhum JSONL de `original_words` sem esta suíte 100% verde.**

> **Desfecho (aprovado pelo dono, 2026-07-22):** o sweep real revelou 58 divergências, todas por
> granularidade verso×palavra (53 Salmos de título-mesclado; 3 fronteiras `StartDifferent` cuja
> informação de split não existe no TVTMS — ali a ref embutida é a única verdade; 2 em Neemias,
> verso só-KJV 7:68). A ref embutida está correta em todos — nenhum canonical_id contaminado.
> Decisão: **concordância módulo granularidade** — o gate exige exatamente o baseline literal das
> 58 (ref + categoria + conjuntos), com falha ruidosa para divergência nova, ausente, alterada ou
> recategorizada. Backlog: enriquecer o mapper com o padrão de títulos da seção Condensed zeraria
> os 53 TM (os 3 StartDifferent são irredutíveis por design do TVTMS).

### N6 — Barrel + fiação
`stepbible/index.ts` reexporta; `parsers/stepbible.ts` vira barrel (`export * from "./stepbible/index.js"`),
removendo `NotImplementedError`; ajusta o barrel de `parsers/`. Sem lógica nova.

## 5. Verificação (por nó)

Comando base: `pnpm --filter @bereia/ingestion test` (+ `typecheck`). Cada nó prova-se por (ADR-008):

| Nó | Prova |
|---|---|
| N1 | Unit de notação (mock sintético: `Psa.3.0(3.1)#01=L`, `2Co.13.13[13.14]#22=K`) + fixture enumerando os códigos de livro dos 6 arquivos reais (`skipIf`). Explode em código/notação desconhecida. |
| N2 | Unit com dStrong reais → Strong normalizado; propriedade: toda saída não-nula casa `/^[HG]\d{1,4}$/`. |
| N3 | Integração `skipIf`: nº exato de palavras (atrelado ao sha256), 0 deuterocanônicos vazando, `strongId`/morfologia amostrados em Gn 1.1; smoke de `SourceInventory` (contagem de palavras de um verso conhecido). |
| N4 | Integração `skipIf`: nº exato de palavras; projeção TR bate os casos Rom 16:24 / 2Co 13:14 / At 8:37; `canonicalId` de 2Co 13:14 e 3Jn 1:14 corretos (colchete KJV). |
| N5 | **Gate**: concordância módulo granularidade — 23.155/23.213 exatas + baseline literal das 58 divergências categorizadas (ver desfecho em §N5); `skipIf` quando faltam arquivos (nunca verde falso). |
| N6 | `typecheck` + suíte inteira verde; `parseTahot`/`parseTagnt` resolvem pelo barrel. |

Comandos de aceite concretos:
- N1: `pnpm --filter @bereia/ingestion test -- refs`
- N2: `pnpm --filter @bereia/ingestion test -- strongs`
- N3: `pnpm --filter @bereia/ingestion test -- tahot`
- N4: `pnpm --filter @bereia/ingestion test -- tagnt`
- N5: `pnpm --filter @bereia/ingestion test -- versification-gate`
- N6: `pnpm --filter @bereia/ingestion test && pnpm --filter @bereia/ingestion typecheck`

## 6. O que este plano NÃO faz (fora de escopo)
- Carregar `strongs` a partir de `openscriptures/strongs` (nó próprio, paralelo — a FK `strong_id` já sai
  pronta daqui).
- Gravar JSONL de `original_words` / `canonical_verses` (nó de load, depende deste + do gate N5 verde).
- Alinhamento palavra-a-palavra PT↔original (fora do MVP, CLAUDE.md §2).
- Modelar subverso no `canonical_id` (decisão já fechada; partes concatenam — spike-tvtms §2).

## 7. Questões em aberto

- **Q1 (ADR-002, para o dono):** aprova o produtor do `canonical_id` ser a **ref KJV embutida** do STEPBible
  (com o mapper TVTMS como gate de verificação em N5), em vez de rodar o mapper como produtor? E aprova a
  **assimetria** TAHOT-tem-gate-de-mapper / TAGNT-lê-colchete (justificada por o golden só validar tradições
  hebraica/inglesa, não grega)? Alternativa (A)/(B) da §3.1 fica pronta caso prefira a letra do ADR.
- **Q2 (schema `original_words`):** a letra de desambiguação do dStrong (`H7225G` vs `H7225`) e as tags de
  prefixo/sufixo `H9xxx` se perdem no `strong_id`. Preservar o dStrong bruto num campo novo
  (`raw_strong`/`dstrong`) exige tocar §5 do schema — vale a pena no MVP, ou fica só o Strong simples + a
  string em `morphology`?
- **Q3 (At 8:37):** a ref `Act.8.37` **não aparece** no TAGNT (só 8.35/8.36) — a numeração primária é NRSV,
  que omite o verso. Onde estão as palavras só-TR de At 8:37? (a) anexadas a 8.36 com colchete `[8.37]`?
  (b) ausentes? N4 precisa **descobrir empiricamente e travar um caso-ouro**; se ausentes, BLIVRE/KJV (TR)
  teriam o verso sem `original_words` correspondente — lacuna a registrar, não um bug do parser.
- **Q4 (variantes Ketiv/Qere e `wordType` minúsculo):** incluir Ketiv (`K` no TAHOT TextType) e leituras
  variantes minúsculas do TAGNT no conjunto principal de `original_words`, ou só o texto-base
  (L / maiúsculas)? Proposta default: carregar tudo carimbado, projeção decide — confirmar.
</content>
</invoke>
