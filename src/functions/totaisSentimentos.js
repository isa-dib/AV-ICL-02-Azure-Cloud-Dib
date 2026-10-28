const { app, input } = require('@azure/functions');

// Input binding: consulta os totais agrupados por sentimento
const sqlInput = input.sql({
    commandText: `
        SELECT Sentimento, COUNT(*) AS Total
        FROM dbo.Sentimentos
        GROUP BY Sentimento
    `,
    commandType: 'Text',
    connectionStringSetting: 'SqlConnectionString'
});

// ========================================
// HTTP function: GET /api/sentimentos
// Retorna { positive: 0, neutral: 0, negative: 0 }
// ========================================

app.http('totaisSentimentos', {
    methods: ['GET'],
    route: 'sentimentos',
    authLevel: 'anonymous',
    extraInputs: [sqlInput],

    handler: async (request, context) => {

        const linhas = context.extraInputs.get(sqlInput) || [];

        const totais = { positive: 0, neutral: 0, negative: 0 };

        for (const linha of linhas) {
            const chave = String(linha.Sentimento).toLowerCase();
            if (chave in totais) {
                totais[chave] = Number(linha.Total);
            }
        }

        context.log('Totais:', totais);

        return {
            status: 200,
            jsonBody: totais
        };
    }
});
