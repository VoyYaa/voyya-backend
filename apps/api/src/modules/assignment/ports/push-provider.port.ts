import type { AssignmentNotification } from '@voyyaa/shared';

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface PushProvider {
  sendAssignment(
    target: { driverId: number },
    notification: AssignmentNotification,
  ): Promise<void>;
}
