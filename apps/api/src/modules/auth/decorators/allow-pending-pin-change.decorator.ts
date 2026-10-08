import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PIN_CHANGE_KEY = 'allowPendingPinChange';

export const AllowPendingPinChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_PIN_CHANGE_KEY, true);
