-- Tabela que recebe o resultado da análise de sentimento
IF OBJECT_ID('dbo.Sentimentos', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Sentimentos (
        Id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ComentarioId  INT               NULL,       -- "id" retornado pelo end-point
        Comentario    NVARCHAR(MAX)     NULL,
        Sentimento    NVARCHAR(10)      NOT NULL,   -- positive | neutral | negative
        ScorePositivo FLOAT             NULL,
        ScoreNeutro   FLOAT             NULL,
        ScoreNegativo FLOAT             NULL,
        DataRegistro  DATETIME2         NOT NULL DEFAULT SYSDATETIME()
    );
END
GO

-- Consulta usada pela http function (totais)
SELECT Sentimento, COUNT(*) AS Total
FROM dbo.Sentimentos
GROUP BY Sentimento;
GO
