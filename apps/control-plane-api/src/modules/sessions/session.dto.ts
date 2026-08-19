import { IsString, IsOptional, IsObject, IsNotEmpty } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  environmentId?: string;

  @IsString()
  @IsNotEmpty()
  browserSessionId: string;

  @IsString()
  @IsNotEmpty()
  pageUrl: string;

  @IsString()
  @IsNotEmpty()
  userAgent: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
