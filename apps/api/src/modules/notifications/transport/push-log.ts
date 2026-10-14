import type { PushLogRef } from '../ports/push-transport.port';

export function pushOwner(userId: number, ref: PushLogRef): string {
  return `${ref.audience}=${userId}`;
}

export function pushSubject(userId: number, ref: PushLogRef): string {
  if (ref.audience === 'driver') return `driver=${userId} assignment=${ref.assignmentId}`;
  return `passenger=${userId} tripRequest=${ref.tripRequestId} type=${ref.type}`;
}

export function pushLagSuffix(ref: PushLogRef, nowMs: number): string {
  if (ref.audience === 'driver') return '';
  return ` lagMs=${Math.max(0, Math.round(nowMs - ref.occurredAtMs))}`;
}
