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
    spans.sort((a, b) => a.startedAt - b.startedAt);
    
    // Build tree/depth
    const entries: TimelineEntry[] = [];
    const spanMap = new Map<string, TimelineEntry>();
    
    for (const span of spans) {
      const entry: TimelineEntry = {
        id: span.id,
        type: 'span',
        source: span.source,
        serviceName: span.serviceName,
        operation: span.operationName,
        method: span.method,
        url: span.url,
        statusCode: span.statusCode,
        durationMs: span.durationMs,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        depth: 0,
        parentId: span.parentSpanId,
        scenarioApplied: span.scenarioApplied,
        isClientSide: span.source === 'browser',
        error: span.error,
      };
      
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        entry.depth = spanMap.get(span.parentSpanId)!.depth + 1;
      }
      
      spanMap.set(span.id, entry);
      entries.push(entry);
    }
    
    return {
      sessionId: session.id,
      entries,
      startTime: entries[0]?.startedAt || session.startedAt.getTime(),
      endTime: entries[entries.length - 1]?.endedAt || session.endedAt?.getTime() || Date.now(),
      services: [...new Set(entries.map(entry => entry.serviceName))]
    };
  }
}
