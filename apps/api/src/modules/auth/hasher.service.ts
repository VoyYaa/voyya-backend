import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { EnvService } from '../../config/env.service';

export const HASHER = Symbol('HASHER');

export interface Hasher {
  hash(plain: string): Promise<string>;
  compare(plain: string, hash: string): Promise<boolean>;
}

@Injectable()
export class BcryptHasher implements Hasher {
  private readonly rounds: number;

  constructor(env: EnvService) {
    this.rounds = env.get('BCRYPT_ROUNDS');
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
