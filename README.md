# Robô do Save Point

Verifica automaticamente se as obras cadastradas no Save Point são conteúdo adulto
e procura discurso de ódio nos comentários, mensagens e memórias.
Roda de graça no GitHub Actions, a cada 10 minutos.

## Como funciona

1. Toda obra nova nasce como **"Verificando…"** (visível só para quem cadastrou).
2. O app já faz uma checagem rápida no navegador (palavras-chave, AniList, Google Books).
   Se achar conteúdo adulto, a obra fica **privada** na hora.
3. Este robô dá a palavra final: consulta **AniList**, **TMDB** (filmes), **Google Books**
   (livros), palavras-chave e analisa a **capa** com o NSFW.js (modelo gratuito que roda aqui).
   - Conteúdo adulto → **privada**: fica só na estante de quem cadastrou e não pode ser compartilhada.
   - Normal → **pública**: entra no catálogo para todos.
   - Sem conseguir consultar nada 3 vezes → fica para a **moderação** decidir no app.

## Configuração (uma vez só)

### 1. Chave da conta de serviço do Firebase
1. Console do Firebase → ⚙️ **Configurações do projeto** → **Contas de serviço**.
2. **Gerar nova chave privada** → baixa um arquivo `.json`.
3. **NUNCA** coloque esse arquivo no repositório. Ele dá acesso total ao banco.

### 2. Segredos no GitHub
No repositório: **Settings → Secrets and variables → Actions → New repository secret**.

| Nome | Valor |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | o conteúdo inteiro do arquivo `.json` (abra no Bloco de Notas, copie tudo e cole) |
| `TMDB_KEY` | *(opcional)* chave gratuita do themoviedb.org para verificar filmes |
| `GOOGLE_BOOKS_KEY` | *(opcional, recomendado)* chave de API do Google Cloud com a **Books API** ativada. Sem ela, o Google costuma limitar as consultas vindas do GitHub e os livros são verificados só pela capa |

Os segredos ficam criptografados e **não aparecem** para quem visita o repositório,
mesmo ele sendo público.

### 3. Ligar o robô
1. **Actions** → se aparecer um aviso, clique em **"I understand my workflows, go ahead and enable them"**.
2. Abra **Robô Save Point** → **Run workflow** para a primeira rodada.
3. Depois disso ele roda sozinho a cada 10 minutos.

### 4. Obras antigas
No app, entre como moderador → **Moderação** → **"Pedir ao robô para verificar obras antigas"**.
Na próxima rodada ele verifica as obras cadastradas antes do robô existir.

## Conferindo se está funcionando
- No app, o painel de **Moderação** mostra a **última rodada** do robô.
- No GitHub, **Actions** mostra o histórico. Por privacidade, os registros mostram só o
  ID da obra e o resultado, nunca o nome.

## Moderação automática (`moderar.cjs`)

A cada rodada, o robô lê **só o que foi escrito desde a rodada anterior** (comentários,
mensagens das conversas com lojas e memórias novas ou editadas) e procura insultos
homofóbicos, racistas, transfóbicos e incitação ao ódio — inclusive disfarçados
(`v1ad0`, `v i a d o`, `viaaado`).

| Encontrou | O que acontece |
|---|---|
| Termo **grave** em comentário | sai do ar e fica guardado em `quarentena` até a moderação decidir (restaurar ou manter apagado) |
| Termo **grave** em memória | fica oculta com o aviso "retirada automaticamente" |
| Qualquer termo em conversa | a conversa é marcada como denunciada, para a moderação poder ler |
| Termo de **atenção** (pode ser ofensa ou não) | o conteúdo continua no ar; só abre a denúncia |

Em todos os casos aparece uma denúncia **"🤖 Detectado automaticamente"** no painel de Moderação.
**O robô nunca suspende ninguém**: quem decide é sempre a moderação.

- O texto não sai do Firebase (nada vai para serviços de fora) e os registros do Actions mostram só IDs.
- Comentários retidos sem decisão por 60 dias são apagados de vez.
- A lista de termos está em `lexico.cjs` (gerada a partir da mesma lista usada no app e nas regras do Firestore).
- Precisa dos índices do `firestore.indexes.json` do app publicados (`firebase deploy --only firestore`).
  Sem eles, o passo mostra "Falta um índice" no registro e o resto do robô continua normalmente.
- Na primeira rodada, olha só as últimas 24 horas.

## Ranking de curadores (`curadores.cjs`)

Conta, direto no Firestore, quantas obras **aprovadas** cada membro cadastrou e grava em `sistema/curadores`.
O app mostra os selos "Top 1/2/3 Curador" a partir daí, então **todos veem o mesmo ranking**.
- Mínimo de 5 obras aprovadas; empate divide a posição.
- Obras ainda "Verificando…" não contam (o perfil da pessoa mostra quantas estão em verificação).
- Só recalcula quando alguma obra mudou ou uma vez por dia (economiza leituras).

## Moedas Save Point (`moedas.cjs`)

Quem credita as moedas é só o robô (a cada rodada, ~30 min). O app apenas **gasta**: as regras do Firestore conferem o preço de cada item, o saldo e se a pessoa já tem o item.

| Ação | Moedas |
|---|---|
| Boas-vindas (primeira vez que abre a loja) | +50 |
| Obra cadastrada e aprovada (até 10 por dia) | +20 |
| Obra concluída na estante (até 10 por dia) | +10 |
| Memória compartilhada (até 3 por dia) | +5 |
| Entrou no app no dia | +2 |
| 7 dias seguidos entrando | +20 |
| Conquista nova | +15 |
| Top 3 dos curadores, na virada do mês | +200 |

- Cada crédito tem uma chave única no extrato (`obra_<id>`, `memoria_<id>`, `dia_<data>`…): a mesma ação nunca paga duas vezes.
- O progresso fica em `/sistema/moedasAuto` (cursores de cada etapa e o resultado da última rodada).
- Precisa dos índices do `firestore.indexes.json` (`estante.atualizadoEm` e `checkin.em` em grupo de coleções). Se faltar, o registro mostra “Falta um índice”: rode `firebase deploy --only firestore`.
- Para dar ou tirar moedas na mão (ex.: fraude), edite `carteiras/<uid>` no console do Firebase (campo `saldo`) e, se quiser, crie uma linha em `carteiras/<uid>/extrato` com `valor`, `motivo` e `criadoEm`.
- **Fim do período alfa:** quando a administração toca em *Moderação → Fim do período alfa → Encerrar período alfa*, a próxima rodada zera o XP e o nível de todos os membros que já tinham conta e entrega a Coleção Alfa (avatar, moldura, banner e tema). O andamento aparece na própria seção da moderação e em `/sistema/alfa`.
- Ao mudar o preço de um item no app (`ITENS_LOJA`), mude também em `precosLoja()` no `firestore.rules`.

## Calendário automático de lançamentos (`lancamentos.cjs`)

No **penúltimo dia de cada mês** (horário de Brasília), o robô procura os lançamentos do mês seguinte
das obras que estão no catálogo e coloca no calendário, com a etiqueta **🤖 Robô**:

| Tipo | Fonte | O que entra |
|---|---|---|
| Animes | AniList | estreia de temporada nova (com horário) e episódio final da temporada |
| Séries | TMDB (`TMDB_KEY`) | estreia de temporada nova e episódio final da temporada |
| Filmes | TMDB (`TMDB_KEY`) | estreia nos cinemas do **Brasil** (só filmes do ano atual, do anterior ou sem ano) |

- Mangás, manhwas e livros continuam com a moderação (não há fonte gratuita confiável das datas no Brasil).
- Jogos ainda não entram (dá para ligar depois com uma chave gratuita do RAWG).
- Rodar de novo **não duplica**. Se a moderação **editar** um lançamento do robô, ele não mexe mais nele.
- Catálogo grande: o trabalho é dividido em rodadas de até 4 minutos e continua na rodada seguinte.
- No app, em **Novidades → Lançamentos**, a moderação tem o botão **"🤖 Buscar lançamentos agora"**
  (de hoje até o fim do mês seguinte), útil na primeira vez ou depois de cadastrar obras novas.

## Catálogo na Cloudflare Pages (`exportar.cjs`)

Depois de verificar as obras, o robô publica o catálogo público como arquivos estáticos
na Cloudflare Pages (grátis e ilimitado). O app baixa de lá e só pede ao Firestore as obras
alteradas depois disso.

- Publica no máximo a cada 3 horas e só quando algo mudou (fica bem abaixo das 500 publicações/mês).
- Lê do Firestore só as obras alteradas; uma vez por semana refaz tudo.
- Para republicar na hora: Actions → Robô Save Point → Run workflow → marque "Republicar o catálogo".

Configuração (Settings → Secrets and variables → Actions):
- Secrets: `CLOUDFLARE_API_TOKEN` (modelo "Edit Cloudflare Workers" ou permissão "Cloudflare Pages: Edit"), `CLOUDFLARE_ACCOUNT_ID`
- Variables: `CATALOGO_PROJETO` (ex.: `savepoint-catalogo`) e `CATALOGO_URL` (ex.: `https://savepoint-catalogo.pages.dev`)

Sem essas configurações, a exportação fica desligada e o app continua lendo o catálogo do Firestore.
