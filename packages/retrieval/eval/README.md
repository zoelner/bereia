# Eval de retrieval — perguntas-ouro

Referência: `docs/plano-fase2-retrieval.md` §5 (gate da Fase 2) e nó N7.

## O que é

Um arquivo de "perguntas-ouro" é um JSONL (uma linha JSON por caso) onde cada
linha descreve uma `query` de busca temática e os `canonicalId`s
(`expectedIds`) que `searchByTheme` deve trazer para essa query. O harness de
eval (N8, `packages/retrieval/eval/harness.ts`) roda cada caso contra o
`PgRetrieval` e compara o resultado com o esperado — é o "snapshot test"
citado no gate da fase.

## Formato (validado por `schema.ts`)

```json
{
  "id": "slug-kebab-case",
  "query": "texto de busca",
  "translation": "KJV",
  "limit": 10,
  "strict": false,
  "expectedIds": ["GEN_1_1", "GEN_1_2"],
  "note": "por que este caso existe / quem curou"
}
```

- `id`: slug único no arquivo (kebab-case minúsculo). Duplicar `id` no mesmo
  arquivo é erro.
- `query`: texto livre, não pode ser vazio.
- `translation` (opcional): filtra a tradução buscada (ex.: `KJV`).
- `limit` (opcional, default `10`): o N do critério de cobertura — ver abaixo.
- `strict` (opcional, default `false`): opt-in por caso. Ver critério.
- `expectedIds`: lista não vazia de `canonical_id`s válidos (`BOOK_CHAPTER_VERSE`,
  validados contra o mesmo `canonicalIdSchema` de `@bereia/core`).
- `note`: texto livre — documenta a intenção do caso e, para casos reais, a
  curadoria por trás dele.

Uma linha vazia, JSON malformado, ou linha que não valida contra o schema faz
`parseEvalCasesJsonl` explodir citando o **número da linha** — nunca falha em
silêncio.

## Critério de cobertura (OQ-6)

- **Cobertura (default):** todos os `expectedIds` do caso precisam aparecer
  entre os primeiros `limit` resultados de `searchByTheme` (`expectedIds ⊆
  topN`), independente da posição relativa entre eles.
- **`strict: true` (opt-in por caso):** exatidão de **prefixo** — os
  `expectedIds`, NA ORDEM EXATA declarada, precisam ocupar o topo do
  resultado.
- Em ambos os casos, a asserção de **determinismo** do harness (mesma query
  duas vezes ⇒ mesma lista de IDs, mesma ordem) é independente do critério de
  cobertura e reprova o gate por conta própria se falhar.

## Dois arquivos, dois propósitos

- **`perguntas-ouro.mock.jsonl`** (este pacote, versionado, roda no CI): casos
  **neutros**, sintéticos, marcados como `mock` nas próprias queries/notas.
  Os `expectedIds` são `canonical_id`s estruturalmente válidos (ex.:
  `GEN_1_1`), mas **não carregam nenhuma afirmação teológica** — servem só
  para exercitar schema, harness e determinismo do retrieval sem depender de
  curadoria real. **Nunca adicione conteúdo teológico real aqui** (CLAUDE.md §7).
- **`perguntas-ouro.jsonl`** (N9, curadoria do dono): o arquivo com queries e
  `expectedIds` **reais**, curados pelo dono (autoridade teológica) via
  `data-steward` — análogo ao N11 da Fase 1. Vive junto ao dado real
  (`bereia-data`, ADR-009) e nunca é inventado por agente.

## Como o dono adiciona casos reais

1. Definir a query temática e os versos esperados (curadoria — não é tarefa
   de agente de código).
2. Registrar via `data-steward` (nó N9): uma linha JSONL no formato acima em
   `packages/retrieval/eval/perguntas-ouro.jsonl`, com `note` explicando a
   curadoria.
3. Rodar o harness (N8) contra o Postgres carregado (`DATABASE_URL` setado) e
   confirmar que o caso passa o critério de cobertura/`strict` antes de
   commitar.

## Nota de configuração (aviso do verifier N8)

Um caso com `expectedIds.length > limit` não explode — reprova naturalmente por cobertura
(`missing` preenchido). Ao escrever casos reais, garanta `limit >= expectedIds.length`
(o default de `limit` é 10).
