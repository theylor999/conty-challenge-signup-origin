# Origem do cadastro no app

API que registra de onde veio cada criador e, no cadastro, congela uma decisão que dá para auditar: qual origem venceu, quais toques foram considerados e por que cada um ganhou ou não.

O link muitas vezes abre dentro de um webview que não manda referrer. Por isso a origem viaja explícita no link, e o servidor é a fonte do horário do clique.

## O contrato

```
clique no link  ->  primeira abertura do app  ->  toques  ->  cadastro
```

1. **Clique.** `GET /i/:code` grava um clique com `click_id` gerado no servidor e responde `302` para a landing/loja com `cty_src`, `cty_ref` e `ctyc=<click_id>`. A landing repassa esses parâmetros ao app (deep link ou install referrer). Clicar não é tocar: só vira toque quando o app reporta.
2. **Primeira abertura.** O app gera e guarda um `install_id` e chama `POST /installs/:install_id/first-open`. É idempotente: a segunda chamada devolve o `first_opened_at` original e nunca o move. O app repete a chamada até receber 2xx.
3. **Toque.** Toda vez que o app abre por um link, chama `POST /touches` com `{install_id, click_id, opened_at}`. `opened_at` é obrigatório: é o instante em que o app abriu o link, guardado no aparelho para o reenvio ser idêntico. Antes da primeira abertura a API responde `409 first_open_required`.
4. **Cadastro.** O backend chama `POST /signups` com `{user_id, install_id, signed_up_at}`. A decisão é calculada uma vez, gravada e devolvida igual em chamadas repetidas e em `GET /signups/:user_id/attribution`.

| Rota | Função |
| --- | --- |
| `POST /links` | cria o link `{kind, ref, code?}` (uso interno) |
| `GET /i/:code` | registra o clique e redireciona |
| `POST /installs/:install_id/first-open` | `201` na primeira vez, `200` depois |
| `POST /touches` | `201` toque novo, `200` com `duplicate: true` |
| `POST /signups` | `201` decisão nova, `200` repetição |
| `GET /signups/:user_id/attribution` | a mesma decisão, para auditoria |

### Links de exemplo

| Tipo | Link curto | Deep link (sem clique) |
| --- | --- | --- |
| campanha | `https://conty.app/i/verao26` | `conty://open?cty_src=campaign&cty_ref=cmp_123` |
| indicação | `https://conty.app/i/ana` | `conty://open?cty_src=referral&cty_ref=ana_silva` |

Tipos: `campaign` (`ref` = id da campanha), `referral` (`ref` = código do criador que indicou), `community`. Depois do clique o deep link ganha `&ctyc=clk_...`. `parseLinkParams` e `buildDeepLink` (`src/domain/links.ts`) são a referência para o SDK do app.

Com `click_id`, `kind`, `ref` e o horário do toque vêm do registro do servidor; o app só confirma (divergência dá `422 click_mismatch`, id desconhecido dá `422 unknown_click`). Sem `click_id` (deep link colado), `kind` e `ref` são obrigatórios e o horário do toque é o `opened_at` do app.

### Repetição

- Mesmo `click_id` no mesmo `install_id`: um toque só (`UNIQUE` no banco). Os relatos extras viram uma linha `duplicate_click` na auditoria.
- Sem `click_id`: a chave é `hash(kind, ref, opened_at)`. Reenvio idêntico (mesmo `opened_at`) é o mesmo toque; abrir o link de novo em outro instante é outro toque, da mesma origem.
- Dois cliques físicos no mesmo link são dois toques da mesma origem; o mais recente vence e o outro aparece como `lost_to_later_touch`.

## Janela

Padrão: **7 dias** depois da primeira abertura (`ATTRIBUTION_WINDOW_DAYS`) e **24 horas** de antecedência para o clique que causou a instalação (`PRE_INSTALL_LOOKBACK_HOURS`). Sete dias cobre o tempo normal de um criador testar o app e se cadastrar sem deixar o link velho levar o crédito; 24 horas cobre clique, loja e download sem deixar um clique antigo reivindicar a instalação. O valor usado vai em cada resposta (`rule_config`).

```
      F - 24h                    F (1a abertura)                      F + 7d
         |-----------------------------|-----------------------------------|
 clique que causou o install    ----->     toque e cadastro valem      (fim inclusivo)

 fora: toque < F - 24h  |  dentro: F - 24h <= toque <= min(cadastro, F + 7d)  |  fora: toque > F + 7d
```

Função pura `classifyTouch` (`src/domain/attribution.ts`). Um toque é elegível se, e só se:

`F - 24h <= toque <= min(signed_up_at, F + 7d)`, `opened_at <= signed_up_at` **e** `signed_up_at <= F + 7d`.

"Toque" é o horário do clique (servidor) ou, em link colado, o `opened_at`. O `opened_at` entra só no corte do cadastro: clique antes do cadastro, mas link aberto no app depois dele, não conta.

- Os dois extremos são inclusivos, ao milissegundo.
- Toque ou abertura do link depois do cadastro: `after_signup`, mesmo se também estiver fora da janela.
- Toque fora de `[F - 24h, F + 7d]`: `outside_window`.
- Cadastro depois de `F + 7d`: a origem é orgânica com `window_expired`, e os toques dentro da janela recebem `signup_after_window`. Foi a leitura que escolhi para "cadastro depois do fim da janela"; o crédito expira junto com a janela.

## Quem vence

Último toque elegível vence (`last-touch-v1`, `decideAttribution`). O toque mais recente é o que mais provavelmente levou ao cadastro, e primeiro toque deixaria um clique antigo de campanha tomar o crédito de uma indicação feita depois.

Empate no mesmo instante, nesta ordem:

1. tipo: `referral` > `campaign` > `community` (indicação é uma pessoa dando a cara; comunidade é o alcance mais largo);
2. menor identificador do toque: o `click_id` e, em link colado, `link:<hash>`. É arbitrário, mas estável: o resultado não depende da ordem de chegada. Na prática, em empate do mesmo tipo, o clique do servidor (`clk_...`) ordena antes do link colado.

Resultado por toque: `won`, `lost_to_later_touch`, `lost_tie_break`, `after_signup`, `outside_window`, `signup_after_window`, `duplicate_click`, `install_already_used`, sempre com `reason` em pt-BR.

Sem origem, o cadastro é `organic` com `reason_code` gravado, nesta precedência: `no_first_open`, `install_already_used` (outro usuário já consumiu aquele `install_id`; a auditoria ainda lista a janela e os toques), `window_expired` (vale com ou sem toques), `no_touches`, `no_eligible_touch`.

## Resposta de auditoria

Saída real, capturada com o servidor rodando (`PORT=3055`, linhas de `curl` abreviadas). Um clique de campanha, outro de indicação um segundo depois, o mesmo clique reportado duas vezes, depois o cadastro:

```
POST /links          {"kind":"referral","ref":"ana_silva","code":"ana"}
  {"code":"ana","kind":"referral","ref":"ana_silva","short_url":"https://conty.app/i/ana","deep_link":"conty://open?cty_src=referral&cty_ref=ana_silva"}
POST /installs/inst-7f3a9c1e/first-open
  {"created":true,"install_id":"inst-7f3a9c1e","first_opened_at":"2026-10-09T15:41:11.121Z"}
GET  /i/verao26      -> location: https://conty.app/app?cty_src=campaign&cty_ref=cmp_123&ctyc=clk_dpwZd-GKTTHr
GET  /i/ana          -> location: https://conty.app/app?cty_src=referral&cty_ref=ana_silva&ctyc=clk_fuJneuwbLJit
POST /touches        {"install_id":"inst-7f3a9c1e","click_id":"clk_dpwZd-GKTTHr","opened_at":"2026-10-09T15:41:12Z"}
  {"duplicate":false,"touch_id":"tch_478b92ca44ab8f8f","kind":"campaign","ref":"cmp_123","at":"2026-10-09T15:41:11.158Z","at_source":"click","signup_frozen":false}
POST /touches        (clk_fuJneuwbLJit, indicação)
  {"duplicate":false,"touch_id":"tch_2386c04ee67aa968","kind":"referral","ref":"ana_silva","at":"2026-10-09T15:41:12.266Z","at_source":"click","signup_frozen":false}
POST /touches        (clk_fuJneuwbLJit de novo)
  {"duplicate":true,"touch_id":"tch_2386c04ee67aa968","kind":"referral","ref":"ana_silva","at":"2026-10-09T15:41:12.266Z","at_source":"click","signup_frozen":false}
POST /signups        {"user_id":"usr_501","install_id":"inst-7f3a9c1e"}
```

```json
{
  "user_id": "usr_501",
  "install_id": "inst-7f3a9c1e",
  "signed_up_at": "2026-10-09T15:41:13.562Z",
  "decided_at": "2026-10-09T15:41:13.562Z",
  "origin": {
    "kind": "referral",
    "ref": "ana_silva",
    "touch_id": "tch_2386c04ee67aa968",
    "reason": "Último toque elegível antes do cadastro: referral ana_silva em 2026-10-09T15:41:12.266Z."
  },
  "window": {
    "first_opened_at": "2026-10-09T15:41:11.121Z",
    "starts_at": "2026-10-08T15:41:11.121Z",
    "ends_at": "2026-10-16T15:41:11.121Z"
  },
  "touches": [
    {
      "touch_id": "tch_478b92ca44ab8f8f",
      "duplicate_of": null,
      "click_id": "clk_dpwZd-GKTTHr",
      "kind": "campaign",
      "ref": "cmp_123",
      "at": "2026-10-09T15:41:11.158Z",
      "at_source": "click",
      "opened_at": "2026-10-09T15:41:12.000Z",
      "outcome": "lost_to_later_touch",
      "reason": "Perdeu para um toque elegível mais recente: referral ana_silva em 2026-10-09T15:41:12.266Z (regra: o último toque vence).",
      "ignored_reports": 0
    },
    {
      "touch_id": "tch_2386c04ee67aa968",
      "duplicate_of": null,
      "click_id": "clk_fuJneuwbLJit",
      "kind": "referral",
      "ref": "ana_silva",
      "at": "2026-10-09T15:41:12.266Z",
      "at_source": "click",
      "opened_at": "2026-10-09T15:41:12.000Z",
      "outcome": "won",
      "reason": "Último toque elegível antes do cadastro: referral ana_silva em 2026-10-09T15:41:12.266Z.",
      "ignored_reports": 0
    },
    {
      "touch_id": null,
      "duplicate_of": "tch_2386c04ee67aa968",
      "click_id": "clk_fuJneuwbLJit",
      "kind": "referral",
      "ref": "ana_silva",
      "at": "2026-10-09T15:41:12.266Z",
      "at_source": "click",
      "opened_at": "2026-10-09T15:41:12.000Z",
      "outcome": "duplicate_click",
      "reason": "O mesmo clique (clk_fuJneuwbLJit) foi reportado mais 1 vez(es); conta uma só vez, no toque tch_2386c04ee67aa968.",
      "ignored_reports": 1
    }
  ],
  "rule_version": "last-touch-v1",
  "rule_config": {
    "window_seconds": 604800,
    "pre_install_lookback_seconds": 86400
  }
}
```

Depois disso, o clique em outro link (comunidade) foi reportado: `POST /touches` respondeu `201` com `"signup_frozen": true`, e `GET /signups/usr_501/attribution` continuou idêntico ao corpo acima (`diff` vazio). Um cadastro sem `install_id` volta organic com motivo:

```json
{ "kind": "organic", "reason_code": "no_first_open", "reason": "Nenhuma primeira abertura do app registrada para este cadastro (install_id ausente ou desconhecido); sem janela para medir a origem." }
```

A lista `touches` vem em ordem cronológica. Em empate de horário, o de melhor ranking fica por último. `opened_at` aparece em cada toque.

### Congelamento

O cadastro grava o JSON da decisão. Toque que chega depois fica guardado, mas não altera nada, inclusive um toque atrasado cujo horário é anterior ao cadastro: a decisão vale pelo que o servidor sabia no `POST /signups`. Repetir o cadastro devolve o mesmo corpo (`200`); mesmo `user_id` com `install_id` ou `signed_up_at` diferente dá `409 signup_conflict`.

## Rodar

Node 22.13 ou mais novo (`node:sqlite` sem flag).

```
npm install
npm run dev        # http://localhost:3000
npm test
npm run typecheck
```

Variáveis: `PORT`, `DB_PATH` (padrão `data/attribution.db`), `ATTRIBUTION_WINDOW_DAYS`, `PRE_INSTALL_LOOKBACK_HOURS`, `PUBLIC_BASE_URL`, `REDIRECT_BASE_URL`.

Estrutura: `src/domain` (links, janela, regra de vitória, motivos; sem I/O), `src/db.ts` (node:sqlite, schema e constraints), `src/service.ts` (casos de uso), `src/app.ts` (Hono), `src/clock.ts` (relógio injetado).

## Testes

`npm test` roda 68 testes com relógio controlado, em memória:

- domínio: janela e bordas ao milissegundo, último toque, empate por tipo e por `click_id` em qualquer ordem de entrada, todos os motivos orgânicos;
- HTTP: dois links diferentes, empate exato de horário, mesmo clique duas vezes, toque depois do cadastro, link aberto depois de um cadastro enviado com atraso, toque fora da janela, cadastro sem toques, cadastro sem primeira abertura, `first-open` duas vezes sem mover a janela, decisão imutável após novos toques, auditoria igual ao cadastro, constraints do SQLite.

## O que ficou de fora

- **Sem fingerprinting, de propósito.** Nada de IP, user agent ou device id para "adivinhar" a origem. Sem `click_id` nem link, o cadastro é orgânico e diz por quê.
- Install referrer da loja (Google Play Install Referrer, SKAdNetwork no iOS) como segunda fonte do `click_id`: trabalho futuro.
- Autenticação nas rotas e rate limit. `POST /links`, `/signups` e o `GET` de auditoria seriam internos; `/touches` e `first-open` ficariam abertos ao app com token do app.
- Auto-indicação (criador abrindo o próprio link de indicação): exige saber o código do criador no cadastro.
- Um `install_id` só atribui um cadastro. Aparelho compartilhado por duas contas vira `install_already_used` para a segunda.
- O relógio do app é aceito (até 5 min à frente do servidor) em `opened_at` e na primeira abertura. Relógio errado no aparelho desloca a janela e pode excluir um toque pelo corte do cadastro; o horário do clique com `click_id` vem do servidor.
- Bots e prévias de link também geram clique; só viram toque se o app reportar.
- Não há expurgo de cliques antigos.

## Uso de IA

O código e os testes foram escritos com um assistente de IA (Claude), que eu dirigi, e conferi cada regra contra o enunciado. O que eu revisei e ajustei:

- A leitura de "cadastro depois do fim da janela": decidi que o cadastro fora da janela é orgânico (`window_expired`) mesmo com toque dentro dela e mesmo sem toque nenhum, e que esses toques ganham `signup_after_window`, para a auditoria não dizer "venceu" nem "fora da janela" quando o motivo é outro.
- `kind`, `ref` e horário do clique saem do registro do servidor, não do corpo do app. O `opened_at` ficou obrigatório e também corta: um cadastro enviado com atraso não credita um link que o app só abriu depois dele, mesmo com o clique anterior.
- A linha `duplicate_click` primeiro saiu repetindo o `touch_id` do toque original; mudei para `touch_id: null` com `duplicate_of`, para ninguém contar o toque duas vezes ao ler a lista.
- Os testes de borda (clique em `F - 24h` exato, cadastro em `F + 7d` exato, toque no mesmo milissegundo do cadastro, data inexistente como 31/02) e o caso de dois usuários no mesmo `install_id`, que o enunciado não pedia mas gerava origem duplicada; a auditoria do segundo ainda lista os toques.
