import { Controller, Get, Post, Put, Param, Body, UseGuards, Query } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateSessionDto } from './session.dto';

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  async create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.create(dto);
  }

  @Get()
  async findAll(@Query('skip') skip = 0, @Query('take') take = 50) {
    return this.sessionsService.findAll(Number(skip), Number(take));
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.sessionsService.findOne(id);
  }

  @Get(':id/timeline')
  async getTimeline(@Param('id') id: string) {
    return this.sessionsService.getTimeline(id);
  }

  @Put(':id/end')
  async endSession(@Param('id') id: string) {
    return this.sessionsService.endSession(id);
  }
}
