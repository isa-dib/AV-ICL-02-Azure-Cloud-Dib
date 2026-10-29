# AV-ICL-02-Azure – Análise de Sentimento de Comentários


## End-point de entrega

```
https://func-sentimentos-45766.azurewebsites.net/api/sentimentos
```

> Resposta: JSON com os totais por sentimento, ex.: `{"positive":2,"neutral":4,"negative":7}`.

---

## Comandos executados para a criação dos recursos na Azure

### 0. Pré-requisitos

O **Azure Cloud Shell (Bash)** já tem `az`, `node`, `npm`, `func`, `git`, `zip` e `curl`. Conferir:

```bash
az --version
node --version
func --version
```

Trazer o código do repositório (todos os comandos seguintes rodam dentro desta pasta):

```bash
git clone https://github.com/isa-dib/av-icl-02-Azure-Cloud_Dib.git
cd av-icl-02-azure-cloud-dib
```

Instalar o `sqlcmd`:

```bash
wget https://github.com/microsoft/go-sqlcmd/releases/download/v1.10.0/sqlcmd-linux-amd64.tar.bz2

tar -xvf sqlcmd-linux-amd64.tar.bz2

./sqlcmd --version
```


### 1. Variáveis de ambiente

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

### 2. Registrar os provedores e criar o grupo de recursos

```bash
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.Sql
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.Insights
az provider register --namespace Microsoft.OperationalInsights

az group create --name $RESOURCE_GROUP --location $LOCATION
```

### 5. Azure AI Language (Cognitive Services – análise de sentimento)

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

### 6. Azure SQL Database (SQL Server)

```bash
az sql db list-editions --location $SQL_LOCATION --output table

az sql server create \
  --name $SQL_SERVER \
  --resource-group $RESOURCE_GROUP \
  --location $SQL_LOCATION \
  --admin-user $SQL_ADMIN \
  --admin-password "$SQL_PASSWORD"
```

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

>
#### Criar a tabela com o `sqlcmd`

Conectar ao banco (mesmo formato do material da disciplina):

```bash
./sqlcmd -S $SQL_SERVER.database.windows.net -d $SQL_DB -U $SQL_ADMIN -P "$SQL_PASSWORD"
```

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

String de conexão usada pelos *bindings* SQL:

```bash
export SQL_CONNECTION="Server=tcp:$SQL_SERVER.database.windows.net,1433;Initial Catalog=$SQL_DB;User ID=$SQL_ADMIN;Password=$SQL_PASSWORD;Encrypt=True;"
```

### 5. Storage Account e fila (Storage Queue)

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

### 6. Function App (plano de consumo – gratuito até 1 milhão de execuções/mês)

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

### 7. Configurações da aplicação (app settings)

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

### 8. Publicação das funções

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