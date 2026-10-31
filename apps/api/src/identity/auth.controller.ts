import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import type { MeResponse } from '@ipro/shared';
import { Public, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { requireContext } from '../context/request-context.js';
import { SignInRejected } from './entra/claims.js';
import { SessionsService } from './sessions.service.js';
import { SESSION_COOKIE, readCookie } from './session-token.js';
import { SignInService } from './sign-in.service.js';
import { UsersService, type UserSummary } from './users.service.js';

interface HttpRequest {
  url: string;
  headers: Record<string, string | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
}

const devLoginSchema = z.object({ userId: z.uuid() });

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(SignInService) private readonly signIn: SignInService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Tells the web app which sign-in to show. */
  @Public()
  @Get('mode')
  mode(): { mode: AppConfig['AUTH_MODE'] } {
    return { mode: this.config.AUTH_MODE };
  }

  @Public()
  @Get('dev/users')
  async devUsers(): Promise<UserSummary[]> {
    if (this.config.AUTH_MODE !== 'dev') throw new NotFoundException();
    return this.users.listDevUsers();
  }

  @Public()
  @Post('dev/login')
  @HttpCode(204)
  async devLogin(
    @Body(new ZodPipe(devLoginSchema)) body: z.infer<typeof devLoginSchema>,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<void> {
    const userId = await this.signIn.devSignIn(body.userId);
    res.setHeader('Set-Cookie', await this.sessions.start(userId));
  }

  @Public()
  @Get('login')
  async login(@Query('returnTo') returnTo: unknown, @Res() res: HttpResponse): Promise<void> {
    if (this.config.AUTH_MODE !== 'entra') throw new NotFoundException();
    res.redirect(302, (await this.signIn.beginEntra(returnTo)).href);
  }

  @Public()
  @Get('callback')
  async callback(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    if (this.config.AUTH_MODE !== 'entra' || !this.config.OIDC_REDIRECT_URI) {
      throw new NotFoundException();
    }
    // Rebuild the URL Entra redirected to, so the redirect_uri matches what was registered.
    const callbackUrl = new URL(this.config.OIDC_REDIRECT_URI);
    callbackUrl.search = new URL(req.url, 'http://placeholder').search;
    try {
      const { userId, returnTo } = await this.signIn.completeEntra(callbackUrl);
      res.setHeader('Set-Cookie', await this.sessions.start(userId));
      res.redirect(302, returnTo);
    } catch (error) {
      // Ids only in logs: the request id ties this to the user's report.
      const reason = error instanceof SignInRejected ? error.message : 'unexpected error';
      this.logger.warn(`Sign-in failed (request ${requireContext().requestId}): ${reason}`);
      res.redirect(302, '/?signin=failed');
    }
  }

  @SignedIn()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    res.setHeader('Set-Cookie', await this.sessions.end(token));
  }
}

@Controller('me')
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @SignedIn()
  @Get()
  async me(): Promise<MeResponse> {
    const actor = requireContext().actor!;
    return {
      userId: actor.userId,
      displayName: (await this.users.displayName(actor.userId)) ?? '',
      roles: actor.roles,
    };
  }
}
