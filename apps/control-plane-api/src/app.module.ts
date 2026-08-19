import { Module } from '@nestjs/common';
import { DatabaseModule } from './common/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { ScenariosModule } from './modules/scenarios/scenarios.module';
import { TracesModule } from './modules/traces/traces.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    SessionsModule,
    ScenariosModule,
    TracesModule,
    AuditModule,
  ],
})
export class AppModule {}
