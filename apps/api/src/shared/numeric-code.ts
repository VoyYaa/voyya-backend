import { randomInt } from 'node:crypto';

export function generateNumericCode(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}
