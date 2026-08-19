import { IsString, IsOptional, IsArray, IsEnum } from 'class-validator';
import { Rule, ScenarioStatus } from '@apilens/shared-types';

export class CreateScenarioDto {
  @IsString()
  projectId: string;

  @IsString()
  name: string;

  @IsString()
  description: string;

  @IsArray()
  @IsOptional()
  rules?: Rule[];

  @IsArray()
  @IsOptional()
  tags?: string[];
}

export class UpdateScenarioDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsOptional()
  rules?: Rule[];

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsEnum(['draft', 'active', 'paused', 'archived'])
  @IsOptional()
  status?: ScenarioStatus;
}
