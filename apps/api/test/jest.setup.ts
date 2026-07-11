// Entorno mínimo para los tests, disponible ANTES de importar cualquier módulo
// (ConfigModule.forRoot valida el entorno al importarse). Así los tests son
// self-contained: no dependen de un `.env` local (importante en CI y en el repo
// standalone, que no versiona `.env`). Valores dummy — NUNCA credenciales reales.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/voyya_test?schema=public';
process.env.DIRECT_URL ??= 'postgresql://u:p@localhost:5432/voyya_test?schema=public';
process.env.JWT_SECRET ??= 'test-jwt-secret-0123456789-abcdefghij-xyz';
process.env.QUOTE_TOKEN_SECRET ??= 'test-quote-secret-0123456789-abcdefghij-xyz';
