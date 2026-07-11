import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EnvService } from '../../config/env.service';
import { SMS_PROVIDER } from '../assignment/ports/sms-provider.port';
import { crearSmsProvider } from '../assignment/providers/sms.factory';
import { AuthCleanupService } from './auth-cleanup.service';
import { AuthAdminController, AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { BcryptHasher, HASHER } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

/**
 * Módulo de autenticación (ADR-005). JWT HS256 (access) firmado con JWT_SECRET.
 * A-08: algoritmo FIJADO a HS256 en firma y verificación (no confía en el default).
 * Proveedores externos por PUERTO (DIP): Hasher (bcrypt) y SmsProvider (por factory
 * env-gated; en EV1 el SMS/notificaciones tendrá su propio módulo).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        secret: env.get('JWT_SECRET'),
        signOptions: { expiresIn: env.get('JWT_ACCESS_TTL_SECONDS'), algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, AuthAdminController],
  providers: [
    AuthService,
    AuthRepository,
    RefreshTokenService,
    AuthCleanupService,
    { provide: HASHER, useClass: BcryptHasher },
    { provide: SMS_PROVIDER, useFactory: crearSmsProvider, inject: [EnvService] },
  ],
  // Re-exporta JwtModule para que el JwtAuthGuard GLOBAL (registrado en AppModule)
  // pueda inyectar JwtService.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
