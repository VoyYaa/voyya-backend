import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/decorators/public.decorator';

@Controller('health')
@Public()
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: 'voyya-api'; ts: string } {
    return { status: 'ok', service: 'voyya-api', ts: new Date().toISOString() };
  }
}
