import { Prisma } from '@prisma/client';
import { redactPii } from '@voyyaa/shared';

export interface SafeErrorFields {
  name: string;
  message?: string;
  stack?: string;
  prisma_code?: string;
  sqlstate?: string;
  constraint?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const SQLSTATE_IN_MESSAGE = /\bcode:? \\?["`]([0-9A-Z]{5})\\?["`]/i;
const CONSTRAINT_IN_MESSAGE = /constraint \\?"([A-Za-z0-9_]+)\\?"/;
const IDENTIFIER = /^[A-Za-z0-9_.]+$/;

export function isPrismaError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  );
}

function readMeta(error: Error): Record<string, unknown> {
  const meta: unknown = (error as { meta?: unknown }).meta;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
}

function identifiers(value: unknown): string | undefined {
  const parts = (Array.isArray(value) ? value : [value]).filter(
    (part): part is string => typeof part === 'string' && IDENTIFIER.test(part),
  );
  return parts.length > 0 ? parts.join(',') : undefined;
}

function prismaCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sqlstateOf(error: Error, meta: Record<string, unknown>): string | undefined {
  if (typeof meta.code === 'string' && SQLSTATE.test(meta.code)) return meta.code;
  return SQLSTATE_IN_MESSAGE.exec(error.message)?.[1];
}

function constraintOf(error: Error, meta: Record<string, unknown>): string | undefined {
  const metaMessage = typeof meta.message === 'string' ? meta.message : '';
  return (
    CONSTRAINT_IN_MESSAGE.exec(metaMessage)?.[1] ??
    CONSTRAINT_IN_MESSAGE.exec(error.message)?.[1] ??
    identifiers(meta.constraint) ??
    identifiers(meta.field_name) ??
    identifiers(meta.target)
  );
}

function definedOnly(fields: SafeErrorFields): SafeErrorFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as SafeErrorFields;
}

export function toSafeErrorFields(error: unknown): SafeErrorFields {
  if (!(error instanceof Error)) return { name: 'NonError', message: redactPii(String(error)) };
  if (isPrismaError(error)) {
    const meta = readMeta(error);
    return definedOnly({
      name: error.name,
      prisma_code: prismaCode(error),
      sqlstate: sqlstateOf(error, meta),
      constraint: constraintOf(error, meta),
    });
  }
  return definedOnly({
    name: error.name,
    message: redactPii(error.message),
    stack: error.stack === undefined ? undefined : redactPii(error.stack),
  });
}

export function summarizeError(error: unknown): string {
  const { name, message, prisma_code, sqlstate, constraint } = toSafeErrorFields(error);
  if (message !== undefined) return message;
  const parts = [
    name,
    prisma_code && `prisma_code=${prisma_code}`,
    sqlstate && `sqlstate=${sqlstate}`,
    constraint && `constraint=${constraint}`,
  ];
  return parts.filter(Boolean).join(' ');
}

export function safeStack(error: unknown): string {
  return toSafeErrorFields(error).stack ?? summarizeError(error);
}
