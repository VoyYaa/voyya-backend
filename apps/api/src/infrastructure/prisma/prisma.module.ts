import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Prisma global: un único cliente inyectable en toda la app. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
