import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { TraceSpan as ITraceSpan, SpanSource } from '@apilens/shared-types';

@Entity('trace_spans')
@Index(['sessionId'])
@Index(['traceId'])
export class TraceSpanEntity implements ITraceSpan {
  @PrimaryColumn('uuid')
  id: string;

  @Column()
  traceId: string;

  @Column({ nullable: true })
  parentId: string | null;

  @Column()
  sessionId: string;

  @Column()
  name: string;

  @Column({ type: 'varchar' })
  source: SpanSource;

  @Column({ type: 'timestamp' })
  startTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  endTime: Date | null;

  @Column({ type: 'jsonb', default: {} })
  attributes: Record<string, any>;

  @Column({ type: 'jsonb', default: [] })
  events: Array<{ name: string; timestamp: Date; attributes?: Record<string, any> }>;
}
