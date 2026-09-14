import { Global, Module } from '@nestjs/common';
import { DatabasePreflightService } from './database-preflight.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DatabasePreflightService],
  exports: [PrismaService, DatabasePreflightService],
})
export class PrismaModule {}
