import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Scenario as IScenario, ScenarioStatus, Rule } from '@apilens/shared-types';

@Entity('scenarios')
export class ScenarioEntity implements IScenario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectId: string;

  @Column()
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: ScenarioStatus;

  @Column({ type: 'jsonb', default: [] })
  rules: Rule[];

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ default: 1 })
  version: number;

  @Column()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
