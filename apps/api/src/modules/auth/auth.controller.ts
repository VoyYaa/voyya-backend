import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AdminLoginDTO,
  DriverLoginDTO,
  LogoutDTO,
  type LogoutResponse,
  RefreshDTO,
  type RefreshResponse,
  RequestOtpDTO,
  type RequestOtpResponse,
  type SessionResponse,
  VerifyOtpDTO,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';

const TTL = 60_000;
const LIMIT = { otpRequest: 3, otpVerify: 10, login: 5, refresh: 30 } as const;

@Controller('auth')
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMIT.otpRequest, ttl: TTL } })
  requestOtp(
    @Body(new ZodValidationPipe(RequestOtpDTO)) dto: RequestOtpDTO,
  ): Promise<RequestOtpResponse> {
    return this.auth.requestOtp(dto);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMIT.otpVerify, ttl: TTL } })
  verifyOtp(
    @Body(new ZodValidationPipe(VerifyOtpDTO)) dto: VerifyOtpDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionResponse> {
    return this.auth.verifyOtp(dto, userAgent);
  }

  @Post('driver/login')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMIT.login, ttl: TTL } })
  driverLogin(
    @Body(new ZodValidationPipe(DriverLoginDTO)) dto: DriverLoginDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionResponse> {
    return this.auth.driverLogin(dto, userAgent);
  }

  @Post('admin/login')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMIT.login, ttl: TTL } })
  adminLogin(
    @Body(new ZodValidationPipe(AdminLoginDTO)) dto: AdminLoginDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionResponse> {
    return this.auth.adminLogin(dto, userAgent);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMIT.refresh, ttl: TTL } })
  refresh(
    @Body(new ZodValidationPipe(RefreshDTO)) dto: RefreshDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<RefreshResponse> {
    return this.auth.refresh(dto, userAgent);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body(new ZodValidationPipe(LogoutDTO)) dto: LogoutDTO): Promise<LogoutResponse> {
    return this.auth.logout(dto);
  }
}
