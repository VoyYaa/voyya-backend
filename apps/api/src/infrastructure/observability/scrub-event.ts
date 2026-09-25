import type { Event } from '@sentry/node';
import { redactPiiDeep } from '@voyyaa/shared';
import { toRoutePattern } from './route-pattern';

const ALLOWED_HEADERS = new Set(['user-agent', 'content-type', 'x-request-id']);

function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => ALLOWED_HEADERS.has(key.toLowerCase())),
  );
}

function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return toRoutePattern(new URL(url).pathname);
  } catch {
    return toRoutePattern(url.split('?')[0] ?? url);
  }
}

function scrubRequest(event: Event): void {
  if (!event.request) return;
  delete event.request.data;
  delete event.request.cookies;
  event.request.headers = scrubHeaders(event.request.headers);
  delete event.request.query_string;
  event.request.url = scrubUrl(event.request.url);
}

function scrubUser(event: Event): void {
  if (!event.user) return;
  event.user = event.user.id !== undefined ? { id: event.user.id } : undefined;
}

function hasDiagnosticContent(event: Event): boolean {
  return Boolean(event.exception) || Boolean(event.message);
}

export function scrubEvent(event: Event): Event | null {
  scrubRequest(event);
  scrubUser(event);

  if (event.exception) {
    event.exception = redactPiiDeep(event.exception) as Event['exception'];
  }
  if (event.message) {
    event.message = redactPiiDeep(event.message) as string;
  }
  if (event.extra) {
    event.extra = redactPiiDeep(event.extra) as Event['extra'];
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = redactPiiDeep(event.breadcrumbs) as Event['breadcrumbs'];
  }

  return hasDiagnosticContent(event) ? event : null;
}
