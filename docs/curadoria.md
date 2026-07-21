# Curadoria

## Princípios

- **Fonte de verdade:** edições humanas escrevem no JSONL em `data/canonical/`; o Postgres é projeção.
- **Log append-only:** `curation.jsonl` com `{canonical_id, field, new_value, author, timestamp}`. Nada é editado in-place no log.
- **Rastreabilidade:** todo texto carrega `human_reviewed` (bool) e `reviewed_by`. Conteúdo gerado por IA entra sempre com `human_reviewed=false`.
- **Anti-ambiguidade:** interpretações divergentes viram registros separados em `interpretations` e nunca são fundidas — nem na curadoria, nem na geração.

## Fila de priorização

Ordena o que revisar primeiro, por:

1. **Uso** — versículos mais consultados;
2. **Reports** — apontamentos de usuários (`reports`, status `open`);
3. **Risco doutrinário** — passagens com histórico de interpretação divergente;
4. **Centralidade TSK** — versículos com mais arestas no grafo de referências.

## Fluxo (Fase 5)

Fila priorizada → editar (admin mínimo) → append no `curation.jsonl` → reprojeção no Postgres. A curadoria migra para repositório privado quando houver volume.
