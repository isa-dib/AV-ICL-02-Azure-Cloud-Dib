# AV-ICL-02-Azure – Análise de Sentimento de Comentários

Aplicação serverless na **Azure** que coleta comentários de clientes, avalia o sentimento com o **Azure AI Language (Cognitive Services)**, passa o resultado por uma **Storage Queue**, grava em um **Azure SQL Database (SQL Server)** e expõe os totais por uma **HTTP function**.

> Roteiro feito para a assinatura **Azure for Students** (US$ 100 de crédito): só usa serviços disponíveis nela e só cria recursos nas regiões liberadas pela política da conta.
>
> Todos os recursos usam o **plano gratuito** da Azure (Language `F0`, SQL Database na oferta gratuita, Functions no plano de consumo). A Storage Account (`Standard_LRS`) não tem plano gratuito, mas o custo de uma fila é de centavos e cabe nos créditos do Azure for Students.
>
> Todos os comandos estão em **bash** e foram executados no **Azure Cloud Shell (Bash)** – portal da Azure, ícone `>_` no topo. Também funcionam em qualquer terminal Linux/macOS/WSL com as ferramentas do passo 0.

## Arquitetura

```
 https://backend-n75y.onrender.com/comentarios
        │  {"id":25,"comentario":"Tudo ocorreu conforme o esperado, excelente serviço."}
        ▼
 ┌────────────────────┐   analyzeSentiment   ┌───────────────────────┐
 │ timerComentarios   │ ───────────────────► │ Azure AI Language     │
 │ (timer, 10 s)      │ ◄─────────────────── │ (TextAnalytics)       │
 └─────────┬──────────┘  positive/neutral/   └───────────────────────┘
           │             negative
           ▼ output binding (Storage Queue)
 ┌────────────────────┐
 │ fila-sentimentos   │  Azure Storage Queue
 └─────────┬──────────┘
           ▼ queue trigger
 ┌────────────────────┐  output binding (SQL)   ┌──────────────────────┐
 │ filaSentimentos    │ ──────────────────────► │ Azure SQL            │
 │ (queue function)   │       INSERT            │ dbo.Sentimentos      │
 └────────────────────┘                         └──────────┬───────────┘
                                                           │ input binding (SQL)
 ┌────────────────────┐   GET /api/sentimentos             │
 │ totaisSentimentos  │ ◄──────────────────────────────────┘
 │ (http function)    │ ──► { "positive": 10, "neutral": 3, "negative": 2 }
 └────────────────────┘
```

| Função | Tipo | Arquivo | O que faz |
|---|---|---|---|
| `timerComentarios` | Timer (`*/10 * * * * *`) | `src/functions/timerComentarios.js` | Consulta o end-point a cada 10 s, analisa o sentimento e envia o resultado para a fila |
| `filaSentimentos` | Queue trigger | `src/functions/filaSentimentos.js` | Recebe o resultado da fila e insere na tabela `dbo.Sentimentos` |
| `totaisSentimentos` | HTTP (GET) | `src/functions/totaisSentimentos.js` | Retorna `{ positive, neutral, negative }` com os totais do banco |

Observação: a API de sentimento pode responder `mixed`. Como o enunciado pede apenas `positive`, `neutral` ou `negative`, nesse caso é usado o sentimento com maior *confidence score*.

## Estrutura do repositório

```
av-icl-02-azure/
├── host.json                       # configuração do Functions host + extension bundle (SQL/Queue)
├── package.json
├── local.settings.example.json     # modelo das configurações para execução local
├── sql/
│   └── schema.sql                  # criação da tabela dbo.Sentimentos
└── src/functions/
    ├── timerComentarios.js         # timer function
    ├── filaSentimentos.js          # queue function
    └── totaisSentimentos.js        # http function
```

## End-point de entrega

```
https://<FUNCTION_APP_NAME>.azurewebsites.net/api/sentimentos
```

> Substituir `<FUNCTION_APP_NAME>` pelo nome gerado no passo 2 (o comando do passo 10 mostra a URL completa).

---

## Comandos executados para a criação dos recursos na Azure

### 0. Pré-requisitos

O **Azure Cloud Shell (Bash)** já tem `az`, `node`, `npm`, `func`, `git`, `zip` e `curl`. Conferir:

```bash
az --version
node --version
func --version
```

> Em um Linux local, instalar antes: Azure CLI (`curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`), Node.js LTS e o Functions Core Tools (`npm i -g azure-functions-core-tools@4`).

Trazer o código do repositório (todos os comandos seguintes rodam dentro desta pasta):

```bash
git clone https://github.com/<seu-usuario>/av-icl-02-azure.git
cd av-icl-02-azure
```

Instalar o `sqlcmd` (mesmo procedimento do material da disciplina):

```bash
wget https://github.com/microsoft/go-sqlcmd/releases/download/v1.10.0/sqlcmd-linux-amd64.tar.bz2

tar -xvf sqlcmd-linux-amd64.tar.bz2

./sqlcmd --version
```

> Os arquivos do `sqlcmd` (`sqlcmd`, `sqlcmd_debug`, `NOTICE.md` e o `.tar.bz2`) estão no `.gitignore` e não vão para o repositório nem para o pacote da função.

### 1. Login e verificação da conta Azure for Students

```bash
az login   # no Cloud Shell o login já é automático

# Deve aparecer "Azure for Students" em Assinatura
az account show --query "{Assinatura:name, Id:id, Estado:state}" --output table

# Políticas aplicadas à conta de estudante
# (--disable-scope-strict-match inclui as políticas herdadas, onde fica a restrição de regiões)
az policy assignment list --disable-scope-strict-match --query "[].displayName" --output table

# Regiões em que a conta de estudante pode criar recursos (normalmente 5)
REGIOES=$(az policy assignment list --disable-scope-strict-match \
  --query "[].parameters.listOfAllowedLocations.value[]" -o tsv)
echo "$REGIOES"
```

> A assinatura **Azure for Students** só aceita recursos nas regiões listadas acima; em qualquer outra a criação falha com `RequestDisallowedByAzure`.
>
> Se `REGIOES` vier vazio, veja as regiões no portal: **Policy → Authoring → Assignments → "Allowed resource deployment regions" → Parameters**, e defina manualmente no passo 2 (`export LOCATION=eastus2`, por exemplo).

### 2. Variáveis de ambiente

```bash
export AZURE_CORE_ONLY_SHOW_ERRORS=true

export LOCATION=$(echo "$REGIOES" | head -n 1)   # ou: export LOCATION=eastus2
export SQL_LOCATION=$LOCATION                      # ver observação no passo 5
export RESOURCE_GROUP=rg-av-icl-02
export SUFIXO=$RANDOM

export STORAGE_NAME=stsent$SUFIXO
export FUNCTION_APP_NAME=func-sentimentos-$SUFIXO
export LANGUAGE_NAME=lang-sentimentos-$SUFIXO
export SQL_SERVER=sqlsent$SUFIXO
export SQL_DB=dbsentimentos
export SQL_ADMIN=adminuser
export SQL_PASSWORD='SenhaForte#2026'
export QUEUE_NAME=fila-sentimentos
export COMENTARIOS_URL=https://backend-n75y.onrender.com/comentarios

[ -z "$LOCATION" ] && echo "ERRO: LOCATION vazio - defina a região (passo 1)"

echo "Região: $LOCATION | Function App: $FUNCTION_APP_NAME | SQL Server: $SQL_SERVER | Storage: $STORAGE_NAME"
```

Salvar as variáveis em um arquivo, para recuperá-las se o Cloud Shell for fechado:

```bash
cat > ~/av-icl-02-vars.sh <<EOF
export AZURE_CORE_ONLY_SHOW_ERRORS=true
export LOCATION=$LOCATION
export SQL_LOCATION=$SQL_LOCATION
export RESOURCE_GROUP=$RESOURCE_GROUP
export SUFIXO=$SUFIXO
export STORAGE_NAME=$STORAGE_NAME
export FUNCTION_APP_NAME=$FUNCTION_APP_NAME
export LANGUAGE_NAME=$LANGUAGE_NAME
export SQL_SERVER=$SQL_SERVER
export SQL_DB=$SQL_DB
export SQL_ADMIN=$SQL_ADMIN
export SQL_PASSWORD='$SQL_PASSWORD'
export QUEUE_NAME=$QUEUE_NAME
export COMENTARIOS_URL=$COMENTARIOS_URL
EOF

# Em uma nova sessão:
source ~/av-icl-02-vars.sh
```

> Se trocar `LOCATION` ou `SQL_LOCATION` depois, gere o arquivo de novo.

### 3. Registrar os provedores e criar o grupo de recursos

```bash
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.Sql
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.Insights
az provider register --namespace Microsoft.OperationalInsights

az group create --name $RESOURCE_GROUP --location $LOCATION
```

### 4. Azure AI Language (Cognitive Services – análise de sentimento)

```bash
az cognitiveservices account list-skus --location $LOCATION --kind TextAnalytics --output table

az cognitiveservices account create \
  --name $LANGUAGE_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --kind TextAnalytics \
  --sku F0 \
  --yes

# Endpoint e chave
export LANGUAGE_ENDPOINT=$(az cognitiveservices account show \
  --name $LANGUAGE_NAME \
  --resource-group $RESOURCE_GROUP \
  --query properties.endpoint \
  -o tsv)

export LANGUAGE_KEY=$(az cognitiveservices account keys list \
  --name $LANGUAGE_NAME \
  --resource-group $RESOURCE_GROUP \
  --query key1 \
  -o tsv)

echo $LANGUAGE_ENDPOINT
```

> Se o comando `list-skus` não mostrar `F0` para `$LOCATION`, use outra região da lista `REGIOES` em `--location` (o recurso de Language pode ficar em região diferente das funções).
>
> **Plano gratuito (`F0`)**: até 5.000 textos/mês e só um recurso `F0` do tipo `TextAnalytics` por assinatura (se já existir um, reutilize-o ou remova-o antes).
> Com uma chamada a cada 10 s (8.640/dia) a cota acaba em ~14 h e a API passa a responder `429`. Por isso, depois de testar/entregar, pare a Function App (passo 11).

### 5. Azure SQL Database (SQL Server)

```bash
az sql db list-editions --location $SQL_LOCATION --output table

az sql server create \
  --name $SQL_SERVER \
  --resource-group $RESOURCE_GROUP \
  --location $SQL_LOCATION \
  --admin-user $SQL_ADMIN \
  --admin-password "$SQL_PASSWORD"
```

> **Conta de estudante:** em algumas regiões o Azure for Students não deixa criar SQL Server (erro `RegionDoesNotAllowProvisioning` / *"Provisioning is restricted in this region"*). Nesse caso, escolha outra região da lista `REGIOES` só para o banco e repita o comando acima:
>
> ```bash
> export SQL_LOCATION=westus2   # outra região da lista REGIOES
> ```
>
> A Function App acessa o banco pela internet (porta 1433), então o banco pode ficar em região diferente das funções.

```bash
# Permite o acesso de serviços da Azure (a Function App)
az sql server firewall-rule create \
  --resource-group $RESOURCE_GROUP \
  --server $SQL_SERVER \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0

# Permite o acesso do terminal atual (Cloud Shell) para o sqlcmd
export MEU_IP=$(curl -s https://api.ipify.org)
az sql server firewall-rule create \
  --resource-group $RESOURCE_GROUP \
  --server $SQL_SERVER \
  --name AllowMyIP \
  --start-ip-address $MEU_IP \
  --end-ip-address $MEU_IP

# Banco na oferta gratuita (serverless, 100.000 vCore-segundos + 32 GB por mês)
az sql db create \
  --resource-group $RESOURCE_GROUP \
  --server $SQL_SERVER \
  --name $SQL_DB \
  --edition GeneralPurpose \
  --compute-model Serverless \
  --family Gen5 \
  --capacity 2 \
  --use-free-limit \
  --free-limit-exhaustion-behavior AutoPause

az sql db list --resource-group $RESOURCE_GROUP --server $SQL_SERVER --output table

# Confirma que o banco está na oferta gratuita (deve retornar true)
az sql db show \
  --resource-group $RESOURCE_GROUP \
  --server $SQL_SERVER \
  --name $SQL_DB \
  --query useFreeLimit \
  --output tsv
```

> Se a conta de estudante recusar a oferta gratuita (`--use-free-limit`), crie o banco no tier `Basic` (cerca de US$ 5/mês, descontado dos créditos de estudante):
>
> ```bash
> az sql db create --resource-group $RESOURCE_GROUP --server $SQL_SERVER --name $SQL_DB --service-objective Basic
> ```
>
> Com `AutoPause`, se a cota gratuita do mês acabar o banco é pausado até o mês seguinte, sem gerar cobrança. O banco serverless também pausa sozinho quando fica sem uso; a primeira conexão depois disso pode levar cerca de 1 minuto (as funções tentam de novo automaticamente).
>
> O IP do Cloud Shell muda a cada sessão. Se o `sqlcmd` der erro de firewall, repita os comandos `MEU_IP=...` e `firewall-rule create` acima (use `firewall-rule update` se a regra `AllowMyIP` já existir).

#### Criar a tabela com o `sqlcmd`

Conectar ao banco (mesmo formato do material da disciplina):

```bash
./sqlcmd -S $SQL_SERVER.database.windows.net -d $SQL_DB -U $SQL_ADMIN -P "$SQL_PASSWORD"
```

No prompt `1>` do `sqlcmd`, executar (conteúdo de `sql/schema.sql`):

```sql
CREATE TABLE dbo.Sentimentos (
    Id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    ComentarioId  INT               NULL,
    Comentario    NVARCHAR(MAX)     NULL,
    Sentimento    NVARCHAR(10)      NOT NULL,
    ScorePositivo FLOAT             NULL,
    ScoreNeutro   FLOAT             NULL,
    ScoreNegativo FLOAT             NULL,
    DataRegistro  DATETIME2         NOT NULL DEFAULT SYSDATETIME()
);
GO

SELECT name FROM sys.tables;
GO

QUIT
```

> Alternativa: executar o arquivo direto, sem entrar no prompt:
>
> ```bash
> ./sqlcmd -S $SQL_SERVER.database.windows.net -d $SQL_DB -U $SQL_ADMIN -P "$SQL_PASSWORD" -i sql/schema.sql
> ```

String de conexão usada pelos *bindings* SQL:

```bash
export SQL_CONNECTION="Server=tcp:$SQL_SERVER.database.windows.net,1433;Initial Catalog=$SQL_DB;User ID=$SQL_ADMIN;Password=$SQL_PASSWORD;Encrypt=True;"
```

### 6. Storage Account e fila (Storage Queue)

```bash
az storage account create \
  --name $STORAGE_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --sku Standard_LRS

export AZURE_STORAGE_CONNECTION_STRING=$(
  az storage account show-connection-string \
    --name "$STORAGE_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query connectionString \
    --output tsv
)

az storage queue create \
  --name $QUEUE_NAME \
  --account-name $STORAGE_NAME \
  --connection-string $AZURE_STORAGE_CONNECTION_STRING

az storage queue list --connection-string $AZURE_STORAGE_CONNECTION_STRING --output table
```

### 7. Function App (plano de consumo – gratuito até 1 milhão de execuções/mês)

```bash
az functionapp create \
  --resource-group $RESOURCE_GROUP \
  --consumption-plan-location $LOCATION \
  --os-type Windows \
  --runtime node \
  --runtime-version 22 \
  --functions-version 4 \
  --name $FUNCTION_APP_NAME \
  --storage-account $STORAGE_NAME

az functionapp show \
  --resource-group $RESOURCE_GROUP \
  --name $FUNCTION_APP_NAME \
  --query "{Name:name,State:state,Host:defaultHostName}" \
  --output table
```

> A Function App usa a mesma Storage Account (`AzureWebJobsStorage`), portanto a fila `fila-sentimentos` criada no passo 6 é a usada pelas funções.

### 8. Configurações da aplicação (app settings)

```bash
az functionapp config appsettings set \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --settings "LANGUAGE_ENDPOINT=$LANGUAGE_ENDPOINT" "LANGUAGE_KEY=$LANGUAGE_KEY" "COMENTARIOS_URL=$COMENTARIOS_URL" "SqlConnectionString=$SQL_CONNECTION"

az functionapp config appsettings list \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query "[].name" \
  --output table
```

### 9. Publicação das funções

Na pasta do repositório:

```bash
npm install --omit=dev

rm -f function.zip
zip -qr function.zip host.json package.json package-lock.json src node_modules

az functionapp deployment source config-zip \
  --resource-group $RESOURCE_GROUP \
  --name $FUNCTION_APP_NAME \
  --src function.zip

az functionapp function list \
  --resource-group $RESOURCE_GROUP \
  --name $FUNCTION_APP_NAME \
  --query "[].name" \
  --output table
```

Alternativa com o Functions Core Tools:

```bash
func azure functionapp publish $FUNCTION_APP_NAME
```

### 10. Testes

URL do end-point de totais (entrega):

```bash
HOSTNAME=$(az functionapp show \
  --resource-group $RESOURCE_GROUP \
  --name $FUNCTION_APP_NAME \
  --query defaultHostName \
  --output tsv)

echo "https://$HOSTNAME/api/sentimentos"

curl "https://$HOSTNAME/api/sentimentos"
```

Resposta esperada:

```json
{ "positive": 10, "neutral": 3, "negative": 2 }
```

Acompanhar os logs das funções em tempo real:

```bash
func azure functionapp logstream $FUNCTION_APP_NAME
```

Conferir os registros gravados no banco:

```bash
./sqlcmd -S $SQL_SERVER.database.windows.net -d $SQL_DB -U $SQL_ADMIN -P "$SQL_PASSWORD"
```

```sql
SELECT TOP 10 Id, ComentarioId, Sentimento, LEFT(Comentario, 60) AS Comentario, DataRegistro
FROM dbo.Sentimentos
ORDER BY Id DESC;
GO

SELECT Sentimento, COUNT(*) AS Total
FROM dbo.Sentimentos
GROUP BY Sentimento;
GO

QUIT
```

Ver mensagens na fila (normalmente vazia, pois a queue function consome rapidamente):

```bash
az storage message peek --queue-name $QUEUE_NAME --connection-string $AZURE_STORAGE_CONNECTION_STRING --num-messages 5
```

### 11. Parar / remover os recursos (evitar consumo de créditos)

```bash
# Para a Function App (o timer deixa de chamar a API de sentimento)
az functionapp stop --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP

# Reinicia quando necessário
az functionapp start --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP

# Remove TODOS os recursos do grupo
az group delete --name $RESOURCE_GROUP --yes --no-wait
```

### Problemas comuns na conta Azure for Students

| Erro | Causa | Solução |
|---|---|---|
| `argument --location/-l: expected one argument` | Variável `LOCATION` vazia (sessão nova ou lista de regiões vazia) | `source ~/av-icl-02-vars.sh` ou `export LOCATION=<região>` |
| `RequestDisallowedByAzure` / `RequestDisallowedByPolicy` | Região fora da lista permitida | Usar uma região de `REGIOES` (passo 1) |
| `RegionDoesNotAllowProvisioning` ao criar o SQL Server | Região sem SQL para estudantes | Trocar `SQL_LOCATION` por outra região de `REGIOES` (passo 5) |
| `Cannot open server ... Client with IP address ... is not allowed` no `sqlcmd` | IP do Cloud Shell mudou | Atualizar a regra `AllowMyIP` (passo 5) |
| `InsufficientQuota` / `CanNotCreateMultipleFreeAccounts` no Language | Já existe um recurso `F0` na assinatura | Reutilizar o existente (`az cognitiveservices account list -o table`) ou removê-lo |
| `MissingSubscriptionRegistration` | Provedor não registrado | Repetir os comandos `az provider register` do passo 3 |
| `404 (Not Found)` em `/api/sentimentos` | Nenhuma função carregada (pacote `.zip` sem `host.json` na raiz, sem `node_modules`, ou pasta das funções diferente do `"main"` do `package.json`) | Ver [Diagnóstico do 404](#diagnóstico-do-404) |
| API de sentimento retorna `429` | Cota mensal do `F0` esgotada | Parar a Function App (passo 11) |

### Diagnóstico do 404

```bash
# 1. Quais funções a Function App carregou? (deve listar as 3)
az functionapp function list --resource-group $RESOURCE_GROUP --name $FUNCTION_APP_NAME --query "[].name" --output tsv

# 2. O pacote tem host.json e src/ na raiz e o node_modules/@azure?
unzip -l function.zip | grep -E " host.json| package.json|src/functions/|node_modules/@azure/functions/package.json"

# 3. O "main" do package.json aponta para a pasta que existe? (deve ser src/functions/*.js)
#    Se a pasta tiver outro nome (ex.: src/function), o host sobe mas indexa 0 funções.
grep '"main"' package.json
ls src/functions/*.js

# 4. Configurações de runtime (só os nomes dos settings obrigatórios, sem valores secretos)
az functionapp config appsettings list --resource-group $RESOURCE_GROUP --name $FUNCTION_APP_NAME \
  --query "[?name=='FUNCTIONS_WORKER_RUNTIME' || name=='FUNCTIONS_EXTENSION_VERSION' || name=='WEBSITE_NODE_DEFAULT_VERSION'].{Nome:name,Valor:value}" --output table

az functionapp config appsettings list --resource-group $RESOURCE_GROUP --name $FUNCTION_APP_NAME \
  --query "[?contains('AzureWebJobsStorage SqlConnectionString LANGUAGE_ENDPOINT LANGUAGE_KEY WEBSITE_RUN_FROM_PACKAGE', name)].name" --output tsv
```

> O Functions Core Tools 4.16+ precisa de **Node 22** para instalar via `npm i -g azure-functions-core-tools@4` (com Node 20 o `install.js` falha com `ERR_REQUIRE_ESM`). No Azure Cloud Shell `az`, `func` e o login já estão prontos.

Se a lista do item 1 vier vazia, publicar de novo **de dentro da pasta do repositório** com o Functions Core Tools, que mostra as funções publicadas e as URLs no final:

```bash
cd ~/av-icl-02-azure
npm install
func azure functionapp publish $FUNCTION_APP_NAME
```

Saída esperada no final:

```
Functions in func-sentimentos-XXXXX:
    filaSentimentos - [queueTrigger]
    timerComentarios - [timerTrigger]
    totaisSentimentos - [httpTrigger]
        Invoke url: https://func-sentimentos-XXXXX.azurewebsites.net/api/sentimentos
```

Se ainda assim não aparecerem funções, reiniciar e ver o erro no log:

```bash
az functionapp restart --resource-group $RESOURCE_GROUP --name $FUNCTION_APP_NAME
func azure functionapp logstream $FUNCTION_APP_NAME
```

---

## Execução local (opcional)

```bash
npm install -g azurite
npm install

cp local.settings.example.json local.settings.json
# editar local.settings.json com LANGUAGE_ENDPOINT, LANGUAGE_KEY e SqlConnectionString

# Terminal 1 – emulador do Storage (fila)
azurite --skipApiVersionCheck --location ./data

# Terminal 2 – Functions
func start
```

Testar: `http://localhost:7071/api/sentimentos`

## Publicação no GitHub

```bash
git init
git add .
git commit -m "AV-ICL-02-Azure: análise de sentimento com Azure Functions"
git branch -M main
git remote add origin https://github.com/<seu-usuario>/av-icl-02-azure.git
git push -u origin main
```