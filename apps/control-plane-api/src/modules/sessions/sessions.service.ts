import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionEntity } from './session.entity';
import { CreateSessionDto } from './session.dto';
import { TracesService } from '../traces/traces.service';
import { TimelineData, TimelineEntry, TraceSpan } from '@apilens/shared-types';

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(SessionEntity)
    private sessionsRepository: Repository<SessionEntity>,
    private tracesService: TracesService,
  ) {}

  async create(dto: CreateSessionDto) {
    const session = this.sessionsRepository.create({
      ...dto,
      startedAt: new Date(),
    });
    return this.sessionsRepository.save(session);
  }

  async findAll(skip: number, take: number) {
    const [data, total] = await this.sessionsRepository.findAndCount({
      skip,
      take,
      order: { startedAt: 'DESC' },
    });
    return { data, total };
  }

  async findOne(id: string) {
    const session = await this.sessionsRepository.findOne({ where: { id } });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  async endSession(id: string) {
    const session = await this.findOne(id);
    session.endedAt = new Date();
    return this.sessionsRepository.save(session);
  }

  async getTimeline(id: string): Promise<TimelineData> {
    const session = await this.findOne(id);
    const spans = await this.tracesService.findBySession(id);
    
    // Sort spans by start time
    spans.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    
    // Build tree/depth
    const entries: TimelineEntry[] = [];
    const spanMap = new Map<string, TimelineEntry>();
    
    for (const span of spans) {
      const entry: TimelineEntry = {
        span,
        depth: 0,
      };
      
      if (span.parentId && spanMap.has(span.parentId)) {
        entry.depth = spanMap.get(span.parentId)!.depth + 1;
      }
      
      spanMap.set(span.id, entry);
      entries.push(entry);
    }
    
    return {
      entries,
      totalDurationMs: entries.length > 0 
        ? new Date(entries[entries.length - 1].span.endTime || entries[entries.length - 1].span.startTime).getTime() - 
          new Date(entries[0].span.startTime).getTime()
        : 0
    };
  }
}
