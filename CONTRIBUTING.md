# Contribuindo com o `bereia`

Obrigado pelo interesse! Antes de contribuir, leia com atenção:

## CLA (Contributor License Agreement)

O código deste projeto é licenciado sob **PolyForm Noncommercial 1.0.0** com modelo de dual licensing (uso comercial mediante acordo). Por isso, **toda contribuição externa requer a assinatura prévia de um CLA** cedendo os direitos necessários para o relicenciamento comercial. Abra uma issue antes de enviar qualquer PR — o CLA será disponibilizado no primeiro contato.

PRs enviados sem CLA assinado não poderão ser aceitos, por melhor que sejam.

## Convenções

- **Idioma:** identificadores de código, tabelas, campos de dados e tools em **inglês** (glossário normativo em [`docs/decisoes.md`](docs/decisoes.md)); documentação, commits e conteúdo teológico em **português**.
- **TypeScript strict** em tudo; Python somente no sidecar `embedder/`.
- **Zod em toda fronteira**; nada de `any`; erros explodem cedo com mensagem clara.
- **Commits pequenos e descritivos**, em português.
- **Versões pinadas** para tudo: imagens Docker, revisão do modelo HF, dependências Python.
- **Determinismo é requisito de produto**: qualquer fonte de não-determinismo no retrieval é bug, não detalhe.
- **Nunca inventar dados teológicos/históricos** em seeds ou testes — use placeholders neutros explicitamente marcados como mock.
- Decisões registradas em [`docs/decisoes.md`](docs/decisoes.md) não são reabertas em PR; proponha mudanças via issue.

## Fluxo

1. Abra uma issue descrevendo o problema/proposta.
2. Aguarde alinhamento (e CLA, se for sua primeira contribuição).
3. PR pequeno, com testes, apontando para `main`.
