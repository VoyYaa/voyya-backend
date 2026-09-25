import { Global, Module } from '@nestjs/common';
import { requestContext, RequestContextService } from './request-context.service';

@Global()
@Module({
  providers: [{ provide: RequestContextService, useValue: requestContext }],
  exports: [RequestContextService],
})
export class ObservabilityModule {}
