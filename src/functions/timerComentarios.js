const { app, output } = require('@azure/functions');
const { TextAnalyticsClient, AzureKeyCredential } = require('@azure/ai-text-analytics');

// ========================================
// Configuração
// ========================================

const COMENTARIOS_URL =
    process.env.COMENTARIOS_URL || 'https://backend-n75y.onrender.com/comentarios';

const NOME_FILA = 'fila-sentimentos';

// Output binding: mensagem enviada para a Storage Queue
const filaOutput = output.storageQueue({
    queueName: NOME_FILA,
    connection: 'AzureWebJobsStorage'
});

let clienteLanguage = null;

function obterClienteLanguage() {
    if (!clienteLanguage) {
        const endpoint = process.env.LANGUAGE_ENDPOINT;
        const key = process.env.LANGUAGE_KEY;

        if (!endpoint || !key) {
            throw new Error('LANGUAGE_ENDPOINT e LANGUAGE_KEY devem estar configurados');
        }

        clienteLanguage = new TextAnalyticsClient(endpoint, new AzureKeyCredential(key));
    }
    return clienteLanguage;
}

// ========================================
// Obtém um comentário aleatório do end-point.
// Formato retornado:
// {"id":25,"comentario":"Tudo ocorreu conforme o esperado, excelente serviço."}
// ========================================

async function obterComentario() {
    // O end-point no Render pode demorar para "acordar", por isso o timeout maior
    const resposta = await fetch(COMENTARIOS_URL, { signal: AbortSignal.timeout(60000) });

    if (!resposta.ok) {
        throw new Error(`End-point retornou HTTP ${resposta.status}`);
    }

    const dados = await resposta.json();

    if (!dados || typeof dados.comentario !== 'string' || !dados.comentario.trim()) {
        return null;
    }

    return {
        id: dados.id ?? null,
        comentario: dados.comentario.trim()
    };
}

// ========================================
// Converte o resultado em positive | neutral | negative.
// A API pode retornar "mixed"; nesse caso usa o maior score.
// ========================================

function normalizarSentimento(resultado) {
    const s = resultado.sentiment;
    if (s === 'positive' || s === 'neutral' || s === 'negative') return s;

    const { positive, neutral, negative } = resultado.confidenceScores;
    const maior = Math.max(positive, neutral, negative);
    if (maior === positive) return 'positive';
    if (maior === negative) return 'negative';
    return 'neutral';
}

// ========================================
// Timer function: executa a cada 10 segundos
// (formato NCRONTAB com segundos: seg min hora dia mês dia-semana)
// ========================================

app.timer('timerComentarios', {
    schedule: '*/10 * * * * *',
    extraOutputs: [filaOutput],

    handler: async (myTimer, context) => {

        const dados = await obterComentario();

        if (!dados) {
            context.warn('Nenhum comentário retornado pelo end-point.');
            return;
        }

        context.log(`Comentário obtido (id ${dados.id}):`, dados.comentario);

        const [resultado] = await obterClienteLanguage().analyzeSentiment([dados.comentario], 'pt');

        if (resultado.error) {
            context.error('Erro na análise de sentimento:', resultado.error);
            return;
        }

        const mensagem = {
            comentarioId: dados.id,
            comentario: dados.comentario,
            sentimento: normalizarSentimento(resultado),
            scores: resultado.confidenceScores,
            dataAnalise: new Date().toISOString()
        };

        // Envia o resultado para a fila
        context.extraOutputs.set(filaOutput, mensagem);

        context.log('Resultado enviado para a fila:', mensagem);
    }
});

module.exports = { normalizarSentimento };
