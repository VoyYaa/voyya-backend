import { EnvSchema, type Env } from './env.schema';

/**
 * Valida `process.env` contra el esquema Zod. Se usa como `validate` de
 * `@nestjs/config`, de modo que un entorno inválido FALLA EL ARRANQUE
 * (coding-standards: "falla el arranque si falta una variable").
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detalle}`);
  }
  return parsed.data;
}
