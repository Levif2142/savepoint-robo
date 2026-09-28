# Robô do Save Point

Verifica automaticamente se as obras cadastradas no Save Point são conteúdo adulto.
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
