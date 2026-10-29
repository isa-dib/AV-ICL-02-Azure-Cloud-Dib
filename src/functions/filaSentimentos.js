const { app, output } = require('@azure/functions');

// Output binding: INSERT na tabela dbo.Sentimentos (Azure SQL)
const sqlOutput = output.sql({
    commandText: 'dbo.Sentimentos',
    connectionStringSetting: 'SqlConnectionString'
});

// ========================================
// Queue function: consome a fila e grava no SQL Server
// ========================================

app.storageQueue('filaSentimentos', {
    queueName: 'fila-sentimentos',
    connection: 'AzureWebJobsStorage',
    extraOutputs: [sqlOutput],

    handler: async (message, context) => {

        const msg = typeof message === 'string' ? JSON.parse(message) : message;

        context.log('Mensagem recebida da fila:', msg);

        const permitido = ['positive', 'neutral', 'negative'];
        if (!permitido.includes(msg.sentimento)) {
            context.warn('Sentimento inválido, mensagem ignorada:', msg.sentimento);
            return;
        }

        const registro = {
            ComentarioId: msg.comentarioId ?? null,
            Comentario: msg.comentario,
            Sentimento: msg.sentimento,
            ScorePositivo: msg.scores?.positive ?? null,
            ScoreNeutro: msg.scores?.neutral ?? null,
            ScoreNegativo: msg.scores?.negative ?? null,
            DataRegistro: msg.dataAnalise || new Date().toISOString()
        };

        context.extraOutputs.set(sqlOutput, [registro]);

        context.log('Registro inserido no banco:', registro);
    }
});
