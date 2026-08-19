import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, Query, Request } from '@nestjs/common';
import { ScenariosService } from './scenarios.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateScenarioDto, UpdateScenarioDto } from './scenario.dto';
import { ScenarioStatus } from '@apilens/shared-types';

@Controller('scenarios')
@UseGuards(JwtAuthGuard)
export class ScenariosController {
  constructor(private readonly scenariosService: ScenariosService) {}

  @Get()
  async findAll(
    @Query('skip') skip = 0,
    @Query('take') take = 50,
    @Query('status') status?: ScenarioStatus,
    @Query('tag') tag?: string,
  ) {
    return this.scenariosService.findAll(Number(skip), Number(take), status, tag);
  }

  @Post()
  async create(@Body() dto: CreateScenarioDto, @Request() req: any) {
    return this.scenariosService.create(dto, req.user.id);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.scenariosService.findOne(id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateScenarioDto, @Request() req: any) {
    return this.scenariosService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.scenariosService.softDelete(id, req.user.id);
  }

  @Post(':id/activate')
  async activate(@Param('id') id: string, @Request() req: any) {
    return this.scenariosService.setStatus(id, 'active', req.user.id);
  }

  @Post(':id/deactivate')
  async deactivate(@Param('id') id: string, @Request() req: any) {
    return this.scenariosService.setStatus(id, 'paused', req.user.id);
  }

  @Post(':id/export/playwright')
  async exportPlaywright(@Param('id') id: string) {
    const code = await this.scenariosService.exportAsPlaywright(id);
    return { code };
  }

  @Post(':id/export/json')
  async exportJson(@Param('id') id: string) {
    return this.scenariosService.findOne(id);
  }
}
