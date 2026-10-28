# AV-ICL-02-Azure – Análise de Sentimento de Comentários

Aplicação serverless na **Azure** que coleta comentários de clientes, avalia o sentimento com o **Azure AI Language (Cognitive Services)**, passa o resultado por uma **Storage Queue**, grava em um **Azure SQL Database (SQL Server)** e expõe os totais por uma **HTTP function**.

> Todos os comandos abaixo estão no formato **Windows / PowerShell**. Para executar no Linux/macOS, veja a seção [Equivalentes em bash](#equivalentes-em-bash).

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

### 0. Pré-requisitos (instalação no Windows)

```powershell
winget install -e --id Microsoft.AzureCLI
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Microsoft.Azure.FunctionsCoreTools
winget install -e --id Microsoft.Sqlcmd
winget install -e --id Git.Git
```

Fechar e abrir o PowerShell novamente e conferir as versões:

```powershell
az --version
node --version
func --version
sqlcmd --version
```

### 1. Login e verificação da conta

```powershell
az login
az account show --output table

# Regiões permitidas pela política da conta (Azure for Students)
az policy assignment list --query "[].parameters.listOfAllowedLocations.value[]" -o tsv
```

### 2. Variáveis de ambiente (PowerShell)

> Ajustar `$LOCATION` para uma região da lista acima. As variáveis valem apenas para a janela do PowerShell aberta.

```powershell
$env:AZURE_CORE_ONLY_SHOW_ERRORS = "true"

$LOCATION          = "brazilsouth"
$RESOURCE_GROUP    = "rg-av-icl-02"
$SUFIXO            = Get-Random -Minimum 10000 -Maximum 99999

$STORAGE_NAME      = "stsent$SUFIXO"
$FUNCTION_APP_NAME = "func-sentimentos-$SUFIXO"
$LANGUAGE_NAME     = "lang-sentimentos-$SUFIXO"
$SQL_SERVER        = "sqlsent$SUFIXO"
$SQL_DB            = "dbsentimentos"
$SQL_ADMIN         = "adminuser"
$SQL_PASSWORD      = "SenhaForte#2026"
$QUEUE_NAME        = "fila-sentimentos"
$COMENTARIOS_URL   = "https://backend-n75y.onrender.com/comentarios"

Write-Host "Function App: $FUNCTION_APP_NAME | SQL Server: $SQL_SERVER | Storage: $STORAGE_NAME"
```

### 3. Registrar os provedores e criar o grupo de recursos

```powershell
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.Sql
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.Insights
az provider register --namespace Microsoft.OperationalInsights

az group create --name $RESOURCE_GROUP --location $LOCATION
```

### 4. Azure AI Language (Cognitive Services – análise de sentimento)

```powershell
az cognitiveservices account list-skus --location $LOCATION --kind TextAnalytics --output table

az cognitiveservices account create `
  --name $LANGUAGE_NAME `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --kind TextAnalytics `
  --sku S `
  --yes

# Endpoint e chave
$LANGUAGE_ENDPOINT = az cognitiveservices account show `
  --name $LANGUAGE_NAME `
  --resource-group $RESOURCE_GROUP `
  --query properties.endpoint `
  -o tsv

$LANGUAGE_KEY = az cognitiveservices account keys list `
  --name $LANGUAGE_NAME `
  --resource-group $RESOURCE_GROUP `
  --query key1 `
  -o tsv

Write-Host $LANGUAGE_ENDPOINT
```

> O SKU gratuito `F0` permite ~5.000 textos/mês. Com uma chamada a cada 10 s (8.640/dia), ele esgota em menos de um dia; por isso foi usado `S`. Para usar `F0`, trocar `--sku S` por `--sku F0` (só é permitido um recurso F0 por assinatura).

### 5. Azure SQL Database (SQL Server)

```powershell
az sql db list-editions --location $LOCATION --output table

az sql server create `
  --name $SQL_SERVER `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --admin-user $SQL_ADMIN `
  --admin-password $SQL_PASSWORD

# Permite o acesso de serviços da Azure (a Function App)
az sql server firewall-rule create `
  --resource-group $RESOURCE_GROUP `
  --server $SQL_SERVER `
  --name AllowAzureServices `
  --start-ip-address 0.0.0.0 `
  --end-ip-address 0.0.0.0

# Permite o acesso do meu computador (para criar a tabela com o sqlcmd)
$MEU_IP = (Invoke-RestMethod -Uri "https://api.ipify.org")
az sql server firewall-rule create `
  --resource-group $RESOURCE_GROUP `
  --server $SQL_SERVER `
  --name AllowMyIP `
  --start-ip-address $MEU_IP `
  --end-ip-address $MEU_IP

az sql db create `
  --resource-group $RESOURCE_GROUP `
  --server $SQL_SERVER `
  --name $SQL_DB `
  --service-objective Basic

az sql db list --resource-group $RESOURCE_GROUP --server $SQL_SERVER --output table
```

Criar a tabela `dbo.Sentimentos` (script em `sql/schema.sql`):

```powershell
sqlcmd -S "$SQL_SERVER.database.windows.net" -d $SQL_DB -U $SQL_ADMIN -P $SQL_PASSWORD -i sql\schema.sql
```

String de conexão usada pelos *bindings* SQL:

```powershell
$SQL_CONNECTION = "Server=tcp:$SQL_SERVER.database.windows.net,1433;Initial Catalog=$SQL_DB;User ID=$SQL_ADMIN;Password=$SQL_PASSWORD;Encrypt=True;"
```

### 6. Storage Account e fila (Storage Queue)

```powershell
az storage account create `
  --name $STORAGE_NAME `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --sku Standard_LRS

$AZURE_STORAGE_CONNECTION_STRING = az storage account show-connection-string `
  --name $STORAGE_NAME `
  --resource-group $RESOURCE_GROUP `
  --query connectionString `
  --output tsv

az storage queue create `
  --name $QUEUE_NAME `
  --account-name $STORAGE_NAME `
  --connection-string $AZURE_STORAGE_CONNECTION_STRING

az storage queue list --connection-string $AZURE_STORAGE_CONNECTION_STRING --output table
```

### 7. Function App (plano de consumo, Node.js)

```powershell
az functionapp create `
  --resource-group $RESOURCE_GROUP `
  --consumption-plan-location $LOCATION `
  --os-type Windows `
  --runtime node `
  --runtime-version 22 `
  --functions-version 4 `
  --name $FUNCTION_APP_NAME `
  --storage-account $STORAGE_NAME

az functionapp show `
  --resource-group $RESOURCE_GROUP `
  --name $FUNCTION_APP_NAME `
  --query "{Name:name,State:state,Host:defaultHostName}" `
  --output table
```

> A Function App usa a mesma Storage Account (`AzureWebJobsStorage`), portanto a fila `fila-sentimentos` criada no passo 6 é a usada pelas funções.

### 8. Configurações da aplicação (app settings)

```powershell
az functionapp config appsettings set `
  --name $FUNCTION_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --settings "LANGUAGE_ENDPOINT=$LANGUAGE_ENDPOINT" "LANGUAGE_KEY=$LANGUAGE_KEY" "COMENTARIOS_URL=$COMENTARIOS_URL" "SqlConnectionString=$SQL_CONNECTION"

az functionapp config appsettings list `
  --name $FUNCTION_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --query "[].name" `
  --output table
```

### 9. Publicação das funções

Na pasta do repositório:

```powershell
npm install --omit=dev

# Gera o pacote .zip (tar.exe já vem no Windows 10/11)
if (Test-Path function.zip) { Remove-Item function.zip }
tar.exe -a -c -f function.zip host.json package.json package-lock.json src node_modules

az functionapp deployment source config-zip `
  --resource-group $RESOURCE_GROUP `
  --name $FUNCTION_APP_NAME `
  --src function.zip

az functionapp function list `
  --resource-group $RESOURCE_GROUP `
  --name $FUNCTION_APP_NAME `
  --query "[].name" `
  --output table
```

Alternativa com o Functions Core Tools:

```powershell
func azure functionapp publish $FUNCTION_APP_NAME
```

### 10. Testes

URL do end-point de totais (entrega):

```powershell
$FUNC_HOST = az functionapp show `
  --resource-group $RESOURCE_GROUP `
  --name $FUNCTION_APP_NAME `
  --query defaultHostName `
  --output tsv

Write-Host "https://$FUNC_HOST/api/sentimentos"

Invoke-RestMethod -Uri "https://$FUNC_HOST/api/sentimentos"
# ou
curl.exe "https://$FUNC_HOST/api/sentimentos"
```

Resposta esperada:

```json
{ "positive": 10, "neutral": 3, "negative": 2 }
```

Acompanhar os logs das funções em tempo real:

```powershell
func azure functionapp logstream $FUNCTION_APP_NAME
```

Conferir os registros gravados no banco:

```powershell
sqlcmd -S "$SQL_SERVER.database.windows.net" -d $SQL_DB -U $SQL_ADMIN -P $SQL_PASSWORD `
  -Q "SELECT TOP 10 Id, ComentarioId, Sentimento, LEFT(Comentario, 60) AS Comentario, DataRegistro FROM dbo.Sentimentos ORDER BY Id DESC"

sqlcmd -S "$SQL_SERVER.database.windows.net" -d $SQL_DB -U $SQL_ADMIN -P $SQL_PASSWORD `
  -Q "SELECT Sentimento, COUNT(*) AS Total FROM dbo.Sentimentos GROUP BY Sentimento"
```

Ver mensagens na fila (normalmente vazia, pois a queue function consome rapidamente):

```powershell
az storage message peek --queue-name $QUEUE_NAME --connection-string $AZURE_STORAGE_CONNECTION_STRING --num-messages 5
```

### 11. Parar / remover os recursos (evitar consumo de créditos)

```powershell
# Para a Function App (o timer deixa de chamar a API de sentimento)
az functionapp stop --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP

# Reinicia quando necessário
az functionapp start --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP

# Remove TODOS os recursos do grupo
az group delete --name $RESOURCE_GROUP --yes --no-wait
```

---

## Execução local (opcional)

```powershell
npm install -g azurite
npm install

Copy-Item local.settings.example.json local.settings.json
# editar local.settings.json com LANGUAGE_ENDPOINT, LANGUAGE_KEY e SqlConnectionString

# Terminal 1 – emulador do Storage (fila)
azurite --skipApiVersionCheck --location .\data

# Terminal 2 – Functions
func start
```

Testar: `http://localhost:7071/api/sentimentos`

## Publicação no GitHub

```powershell
git init
git add .
git commit -m "AV-ICL-02-Azure: análise de sentimento com Azure Functions"
git branch -M main
git remote add origin https://github.com/<seu-usuario>/av-icl-02-azure.git
git push -u origin main
```

## Equivalentes em bash

Os comandos `az` são os mesmos. As diferenças são:

| PowerShell | bash |
|---|---|
| `$VAR = "valor"` | `export VAR=valor` |
| `` ` `` no fim da linha (continuação) | `\` no fim da linha |
| `$X = az ... -o tsv` | `X=$(az ... -o tsv)` |
| `Get-Random -Minimum 10000 -Maximum 99999` | `$RANDOM` |
| `Invoke-RestMethod -Uri URL` | `curl URL` |
| `tar.exe -a -c -f function.zip ...` | `zip -r function.zip host.json package.json package-lock.json src node_modules` |
| `Copy-Item a b` | `cp a b` |
