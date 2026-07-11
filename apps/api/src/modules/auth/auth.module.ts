import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EnvService } from '../../config/env.service';
import { SMS_PROVIDER } from '../assignment/ports/sms-provider.port';
import { createSmsProvider } from '../assignment/providers/sms.factory';
import { AuthCleanupService } from './auth-cleanup.service';
import { AuthAdminController, AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { BcryptHasher, HASHER } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

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
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
