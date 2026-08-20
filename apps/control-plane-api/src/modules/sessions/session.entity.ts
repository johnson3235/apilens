import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column({ default: 'default', nullable: true })
  projectId: string;

  @Column({ default: 'development', nullable: true })
  environmentId: string;

  @Column()
  browserSessionId: string;

  @Column()
  pageUrl: string;

  @Column()
  userAgent: string;

  @Column({ type: 'timestamp' })
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;
}
