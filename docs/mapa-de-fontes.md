# Mapa de fontes de dados

Todas gratuitas (Fase 1). Cada fonte baixada ganha `LICENSE.txt` em `data/sources/<fonte>/` com origem, licença e data.

| Fonte | Conteúdo | Formato | Licença | Origem |
|-------|----------|---------|---------|--------|
| Bíblia Livre (BLIVRE) | Tradução PT — Almeida 1819, **Textus Receptus** (Comma 1Jo 5:7 e At 8:37 presentes ✓) | USFX | CC BY 4.0 (© Diego Santos, Mario Sérgio, Marco Teles) | ebible.org (`porbr2018`) |
| ~~Almeida (open-bibles)~~ | **QUARENTENA**: rotulada "Public Domain" no upstream, mas a assinatura textual (1Jo 5:7 sem Comma, colchetes em Mt 6:13/At 8:37, "pairava" em Gn 1:2) a identifica como a "Versão Revisada Segundo os Melhores Textos" (Juerp 1967) — **sob copyright**, difundida indevidamente como PD | USFX | copyright | seven1m/open-bibles |
| ~~Almeida Recebida~~ | **QUARENTENA**: almeidarecebida.org declara "domínio público" E CC BY-NC-SA simultaneamente, tradutor não identificado (apontado pela comunidade Bíblia Livre). O NC conflita com o dual licensing. Não ingerir até esclarecimento por escrito | — | ambígua | almeidarecebida.org |
| KJV | Tradução EN (versificação-mestre) | USFX | Domínio público | ebible.org |
| WEB | Tradução EN moderna | USFX | Domínio público | ebible.org |
| STEPBible TAHOT | AT hebraico tageado (Strong + morfologia) | TSV | CC BY 4.0 | github.com/STEPBible/STEPBible-Data |
| STEPBible TAGNT | NT grego (TR e NA27/28 por edição) | TSV | CC BY 4.0 | github.com/STEPBible/STEPBible-Data |
| STEPBible TVTMS | Mapa de versificação entre tradições | TSV | CC BY 4.0 | github.com/STEPBible/STEPBible-Data |
| openscriptures/strongs | Dicionários Strong (hebraico/grego) | XML/JSON | Domínio público | github.com/openscriptures/strongs |
| OpenBible.info | ~340k referências cruzadas | TSV | CC BY 4.0 | openbible.info/labs/cross-references |
| TSK | Referências cruzadas (alternativa) | — | Domínio público | — |

## Backlog de fontes (candidatas — não ingerir antes do gate TVTMS)

Fontes avaliadas e consideradas valiosas, adiadas porque o MVP valida o pipeline (determinismo + ancoragem), não riqueza de conteúdo — e ingerir antes do gate de versificação multiplicaria retrabalho. Cada uma tem fase-gancho e pendência de verificação própria.

| Candidata | Valor | Fase-gancho | Pendência antes de ingerir |
|-----------|-------|-------------|----------------------------|
| BDB (léxico hebraico, PD 1906) | Definições profundas onde o Strong é telegráfico — alimenta `verse_exegesis` | 4-5 (exegese real) | Confirmar repositório digital (provável `openscriptures/HebrewLexicon`) e formato |
| LXX **Swete** (grego, PD 1909) | Citações do AT no NT frequentemente seguem a LXX, não o massorético — importa para exegese de paradoxos | 4 (eval teológico) | Localizar edição digital estruturada. **Só Swete**: Rahlfs (1935) e Rahlfs-Hanhart são © Deutsche Bibelgesellschaft |
| SBLGNT (CC BY 4.0, relicenciado) | Texto crítico de referência completo (TAGNT já marca divergências TR×NA por edição) | 5 (enriquecimento) | Nenhuma de licença; avaliar ganho real sobre TAGNT |
| Thayer (léxico grego, PD 1889) | Camada complementar ao Strong | 5 (enriquecimento) | Verificar repositório digital; anotar ressalva: pré-papiros, acepções superadas |
| MorphHB (`openscriptures/morphhb`, CC BY 4.0) | Cross-check de qualidade da morfologia do TAHOT | 5 (QA de curadoria) | Nenhuma |
| Almeida 1911 (CrossWire `PorAlmeida1911`) | Segunda tradução PT para o espaço vetorial multilíngue | 5-6 | Verificação de assinatura textual + esclarecer licença (módulo declara GPL, alegação de PD não confirmada) |

Avaliadas e descartadas: JFA 1819/1848 (só scans; a Bíblia Livre já é a modernização dessa linhagem), Vulgata Clementina (baixo valor para os objetivos; tradição latina já coberta pelo TVTMS), "porbrbsl"/Bíblia Portuguesa Mundial (ainda em revisão no upstream).

## Restrições de copyright

**NÃO ingerir:** ACF, ARC, ARA, NVI, Bíblia de Jerusalém (© Paulus/Éditions du Cerf; cópias digitais circulantes são não autorizadas) — todas sob copyright. A ACF permite citação de até 1.100 versículos, insuficiente para indexação. Qualquer tradução nova precisa de verificação de licença ANTES do download.
