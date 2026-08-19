import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TracesController } from './traces.controller';
import { TracesService } from './traces.service';
import { TraceSpanEntity } from './trace-span.entity';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TraceSpanEntity]),
    RedisModule,
  ],
  controllers: [TracesController],
  providers: [TracesService],
  exports: [TracesService],
})
export class TracesModule {}
