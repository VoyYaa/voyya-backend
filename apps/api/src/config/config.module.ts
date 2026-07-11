import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env';
import { EnvService } from './env.service';

/** Config global: valida el entorno con Zod al arrancar y expone EnvService. */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
  providers: [EnvService],
  exports: [EnvService],
})
export class AppConfigModule {}
