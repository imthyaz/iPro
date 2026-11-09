import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { Public } from '../authz/decorators.js';
import { TeamsBotService, type TeamsActivity } from './teams-bot.service.js';

/**
 * The bot's messaging endpoint, registered in Azure Bot (decision #87). No iPro session: each call
 * carries a Bot Framework token, checked before anything else; the person is then looked up by their
 * Entra object id and every decision goes through the same permission checks as in iPro.
 */
@Controller()
export class TeamsBotController {
  constructor(@Inject(TeamsBotService) private readonly bot: TeamsBotService) {}

  @Public()
  @Post('teams/messages')
  @HttpCode(200)
  async messages(
    @Body() activity: TeamsActivity,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return (await this.bot.handle(activity ?? {}, authorization)) ?? {};
  }
}
