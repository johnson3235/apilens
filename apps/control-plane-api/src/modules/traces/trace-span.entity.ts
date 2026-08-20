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

  @Column()
  spanId: string;

  @Column({ nullable: true })
  parentSpanId: string | null;

  @Column()
  sessionId: string;

  @Column()
  serviceName: string;

  @Column()
  operationName: string;

  @Column({ type: 'varchar' })
  source: SpanSource;

  @Column({ nullable: true })
  method: string | null;

  @Column({ nullable: true })
  url: string | null;

  @Column({ nullable: true })
  statusCode: number | null;

  @Column({ type: 'double precision' })
  durationMs: number;

  @Column({ type: 'double precision' })
  startedAt: number;

  @Column({ type: 'double precision' })
  endedAt: number;

  @Column({ type: 'jsonb', default: {} })
  attributes: Record<string, any>;

  @Column({ type: 'jsonb', default: [] })
  events: Array<{ name: string; timestamp: number; attributes: Record<string, string | number | boolean> }>;

  @Column({ nullable: true })
  error: string | null;

  @Column({ nullable: true })
  scenarioApplied: string | null;
}
