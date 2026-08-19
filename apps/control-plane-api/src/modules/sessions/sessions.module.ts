import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionEntity } from './session.entity';
import { TracesModule } from '../traces/traces.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SessionEntity]),
    TracesModule,
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
