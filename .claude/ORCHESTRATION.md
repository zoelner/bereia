# Runbook de orquestração — bereia

Como o trabalho é conduzido: **agenticamente, via subagentes**, escolhendo o nível de
orquestração *por tarefa*, só com o harness do Claude Code (`Workflow` + `Agent`) — sem DAG,
sem driver próprio. O `Workflow` já é o driver determinístico (fan-out, worktree, `agentType`,
schemas de retorno, resume, cap de concorrência); não reconstruímos nada disso.

> **Regra de ouro (Nível 1):** o líder DECIDE e DELEGA. Ler arquivos grandes, buildar, revisar
> e corrigir acontece dentro de subagentes com contexto descartável; só a *conclusão* volta ao
> líder. Nunca auto-merge com gate verde sozinho — um `verifier` fica no loop.

---

## Os agentes (`.claude/agents/`)

| Agente | Papel | modelo default | escreve? |
|---|---|---|---|
| `plan-author` | rascunha ADR / decomposição em nós (o dono aprova) | opus | só o ADR/plano |
| `ts-impl` | implementa um nó TypeScript (`core`/`ingestion`/`mcp-server`) + testes | sonnet | sim (worktree) |
| `data-steward` | fontes de dados: licença ANTES do download, assinatura textual, manifest/sha256, LICENSE.txt, NOTICE | sonnet | sim (worktree) |
| `verifier` | revisão read-only contra ADRs, determinismo, licenças e política de testes | opus | não |
| `gate-runner` | roda `pnpm gate` e devolve PASS/FAIL + saída do erro | haiku | não |

Arquivos de agente são lidos no **início da sessão**. Agente novo/editado só vira
`subagent_type` em sessão nova; no meio da sessão, use
`Agent(subagent_type: general-purpose, model: <tier>)` com as instruções do papel inline.

## Roteamento de modelo (o líder escolhe por chamada, via `model:`/`effort:`)

| Tier | Traço | modelo |
|---|---|---|
| trivial | mecânico e verificável: fixtures, boilerplate, rename | `haiku` |
| standard | feature bem especificada com contrato pronto: um parser com formato levantado, um adapter | `sonnet` |
| hard | arquitetura, versificação/TVTMS, determinismo do retrieval, schema, **todo retry de nó que falhou** | `opus` |

**Suba um tier** se cruzar fronteira de pacote, mexer no contrato de um port, for gargalo de
muitos nós, ou for a **2ª falha** do mesmo nó. **Escalada é effort-first**: num
`CHANGES_NEEDED`, primeiro suba `effort` no mesmo tier; Opus só para nó já `hard`.

## Convenções estáveis (o contrato — não derivar)

- **Nome do agente = `agentType`.** Não renomear.
- **Branch por nó:** `node/<id>` (determinístico).
- **Gate único:** `pnpm gate` (typecheck + testes de todos os pacotes). Nunca duplicar lógica
  de gate. Antes de PR, gate COMPLETO, não subset.
- **Campos de retorno canônicos:** cada agente devolve campos fixos (ver o arquivo dele), para
  acoplar `schema:` no Nível 2-lite sem reescrever nada.
- **Um PR por feature; o merge final é humano.** Auto-merge OFF.
- **Guardrails do projeto valem para todo agente:** decisões da §2 do CLAUDE.md não se reabrem
  sem o dono; identificadores em EN (ADR-000); nunca inventar dado teológico (nem em teste —
  mock neutro); fonte nova exige verificação de licença ANTES do download (ADR-006); commits
  pequenos em PT, sem coautoria de IA.

---

## Os três níveis (todos no harness)

### Nível 1 — líder enxuto + delegação sequencial (default)
Um `Agent` por vez: `plan-author` → **dono aprova** → `ts-impl`/`data-steward`
(`isolation: worktree`) → `verifier` → correção → `gate-runner`. Para **um nó** ou uma
**cadeia dependente** (parser → inventário → mapper → …). Resolve a maior parte do bereia,
que é majoritariamente pipeline sequencial.

### Nível 2-lite — fan-out ad-hoc via `Workflow` (sem DAG)
Quando **≥3 nós disjuntos** estão prontos em paralelo, o líder levanta a work-list inline e roda
**um** `Workflow` com `parallel()`/`pipeline()`:
- nós que escrevem → `isolation: 'worktree'`; `verifier`s read-only → sem worktree;
- cada finding verificado pelo `verifier` (multi-dimensão em paralelo: correção / fidelidade a
  ADR / testes / licenças);
- o líder faz merge das branches `node/<id>` **em ordem de dependência** → `pnpm gate` completo
  → **um** `gh pr create` → dono faz merge.

Decomposição: cada nó ≈ 1 PR (1–5 arquivos, um comando de aceite verificável); nós da mesma
onda com **`scope.paths` disjuntos** (sobreposição ⇒ vira dependência). Work-list é ad-hoc
(via `args` do `Workflow`), **nunca arquivo commitado**.

### Nível 3 — batch autônomo (raro)
`Workflow` longo encadeando fases sem gate humano por passo (impl → review → fix até limpar)
para lote grande e disjunto. **Auto-merge continua OFF.** Reservado, não é meta.

## Rubrica — qual nível

| Sinais | Nível |
|---|---|
| Um nó, cadeia dependente, decisão de arquitetura | **L1** |
| ≥3 nós disjuntos prontos (ex.: TAHOT + TAGNT + Strong depois dos parsers; revisão em 3 dimensões; embed batch por tradução) | **L2-lite** |
| Lote grande disjunto, padrão já provado, menos gate por passo | **L3** |

**Postura default:** trilhos prontos para os três, mas rodar **L1 por default** e escalar a
L2-lite só em janelas genuinamente paralelas.
