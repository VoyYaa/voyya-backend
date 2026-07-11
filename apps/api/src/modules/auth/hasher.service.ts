import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { EnvService } from '../../config/env.service';

/** Token de inyección del puerto de hashing (DIP). */
export const HASHER = Symbol('HASHER');

/**
 * Puerto de hashing para secretos de baja entropía (PIN, contraseña, OTP) — ADR-005 §5.
 * Aísla el algoritmo: migrar a argon2/native-bcrypt es cambiar la implementación.
 */
export interface Hasher {
  hash(plano: string): Promise<string>;
  /** Comparación en tiempo constante (delegada a bcrypt). */
  compare(plano: string, hash: string): Promise<boolean>;
}

/**
 * Implementación bcrypt (coste BCRYPT_ROUNDS). Se usa `bcryptjs` (JS puro, sin
 * compilación nativa → estable en CI/Windows); genera hashes `$2a$` compatibles con
 * bcrypt nativo, así que el puerto permite conmutar sin re-hashear.
 */
@Injectable()
export class BcryptHasher implements Hasher {
  private readonly rounds: number;

  constructor(env: EnvService) {
    this.rounds = env.get('BCRYPT_ROUNDS');
  }

  hash(plano: string): Promise<string> {
    return bcrypt.hash(plano, this.rounds);
  }

  compare(plano: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plano, hash);
  }
}
