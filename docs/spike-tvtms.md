# Spike TVTMS — anexo do ADR-002

> Investigação inicial do arquivo TVTMS (STEPBible, CC BY 4.0) que destrava a Fase 1.
> Fonte: `data/sources/stepbible-tvtms/` (KJV-based, formato novo pós mar/2025 — o formato antigo NRSV-based está em `Older Formats/` no repo upstream e NÃO deve ser usado).

## O que é o arquivo

~30k linhas, duas seções de dados:

- **`#DataStart(Condensed)`** (l.162–4109): blocos `$Ref` com colunas por tradição — legível, ruim de parsear.
- **`#DataStart(Expanded)`** (l.4181–27570): **TSV parseável**, uma linha por mapeamento. É esta que o parser da Fase 1 consome.

Colunas da Expanded: `SourceType, SourceRef, StandardRef, Action, NoteMarker, ReversificationNote, VersificationNote, AncientVersions, Tests`.

**`StandardRef` já é a nossa versificação-mestre (KJV/inglesa)** — o parser mapeia `SourceRef` (na tradição da fonte) → `StandardRef` → `canonical_id`.

## Estatísticas (seção Expanded, ~23k linhas de dado)

| Ação | Linhas | Significado |
|---|---|---|
| Renumber verse (+\*) | 11.815 | verso muda de número entre tradições |
| Keep verse | 8.383 | número igual, mas em contexto que exige confirmação |
| Concatenation | 664 | 1 verso da fonte = N versos standard |
| DividedPrev/MergedPrev (+\*) | 1.128 | splits/merges com o verso anterior |
| IfEmpty / Renumber title / Psalm title | 619 | títulos de Salmos e versos vazios |
| CopiedFrom/MovedFrom | 165 | texto duplicado/movido (LXX etc.) |

Tradições (`SourceType`): Latin, Greek, Hebrew, **Eng-KJV (1.834 linhas — até Bíblias inglesas têm casos!)**, combinações (`Eng-KJV+Hebrew`, …) e variantes (`Greek2`, `GreekUndivided`, `GrkTitleSeparate`, …).

## Descobertas que moldam o parser

1. **Os `Tests` são condicionais sobre o CONTEÚDO da Bíblia-fonte** — ex.: `Gen.3:1=Exist & Gen.2:24=Last`, `Gen.6:1>Gen.6:2` (contagem de palavras!), `TextBeforeV1` (título de Salmo). O mapeador **não é uma tabela estática**: ele precisa do texto-fonte já parseado para avaliar quais regras se aplicam àquela Bíblia. Consequência de pipeline: `parse USFX → avaliar Tests → selecionar tradição efetiva por trecho → aplicar mapeamentos → canonical_id`.
2. **Subversos**: `!a`/`!b` em `SourceRef` (ex.: `Gen.3:1!a`) indicam partes de verso em splits. Nosso `canonical_id` não modela subverso — na Fase 1, partes que mapeiam para o mesmo `StandardRef` são concatenadas; partes que mapeiam para versos distintos seguem o mapeamento.
3. **Códigos de livro próprios** (OSIS-like): `Psa`, `Mal`, `Act`, `Jol`, `3John`… — exige tabela de mapeamento → USFM (`PSA`, `MAL`, `ACT`, `JOL`, `3JN`).
4. **Uma Bíblia pode misturar tradições por trecho** — a seleção de coluna/tradição é por bloco de teste, não global.

## Casos-ouro confirmados no dado (gate da Fase 1)

| Caso | Evidência no TVTMS |
|---|---|
| Títulos de Salmos | `Psa.3:Title → Psa.3:1` (tradição hebraica conta o título como v.1) |
| Malaquias 3/4 | `Mal.4:1-3 → Mal.3:19-21` (hebraico não tem cap. 4) |
| Joel 2/3 | livro `Jol`, fronteiras `1:20; 2:32; 3:21` (hebraico tem 4 caps.) |
| Romanos 16:25-27 | `PassageMoved` — aparece em `Rom.14:24-26` em alguns manuscritos |
| Atos 8:37 | testes `Act.8:37=Exist/NotExist` (ausente em textos críticos) |
| 2Co 13:12-13, 3Jo 14-15, Ap 12:18/13:1 | tabela de diferenças KJV × versões modernas no cabeçalho do arquivo |

## Implicação para as NOSSAS fontes (MVP)

KJV e WEB seguem a tradição inglesa (mapeamento majoritariamente identidade, exceto os casos NT listados no cabeçalho). A **Almeida Recebida precisa de verificação empírica**: base TR sugere tradição inglesa, mas os `Tests` decidem por trecho — é exatamente para isso que o mecanismo existe. Já **TAHOT (hebraico) usa versificação hebraica** — Salmos e Malaquias VÃO divergir; o mapeamento é obrigatório para alinhar `original_words` ao `canonical_id`.

## Próximos passos (ordem)

1. Tabela de códigos TVTMS/OSIS → USFM (fixture versionada + teste).
2. Parser da seção Expanded → estrutura tipada (Zod) com `Action` como enum fechado.
3. Avaliador de `Tests` (Exist/NotExist/Last/contagem de palavras/TextBeforeV1) sobre o output do parser USFX.
4. Suíte de casos-ouro executável (tabela acima) — **gate: 100% antes do 1º JSONL canônico**.
