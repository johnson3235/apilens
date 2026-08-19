import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { TracesService } from './traces.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { TraceSpan } from '@apilens/shared-types';

@Controller()
export class TracesController {
  constructor(private readonly tracesService: TracesService) {}

  @Post('traces/ingest')
  async ingest(@Body() spans: TraceSpan[]) {
    // Basic validation could be added here
    return this.tracesService.ingest(spans);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions/:sessionId/traces')
  async getSessionTraces(@Param('sessionId') sessionId: string) {
    return this.tracesService.findBySession(sessionId);
  }
}
