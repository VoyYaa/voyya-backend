import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Acceso TIPADO a la configuración validada. Evita `configService.get('X')`
 * suelto y sin tipo por el código.
 */
@Injectable()
export class EnvService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }
}
