import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TraceSpanEntity } from './trace-span.entity';
import { TraceSpan } from '@apilens/shared-types';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class TracesService {
  private readonly logger = new Logger(TracesService.name);

  constructor(
    @InjectRepository(TraceSpanEntity)
    private traceRepository: Repository<TraceSpanEntity>,
    private redisService: RedisService,
  ) {}

  async ingest(spans: TraceSpan[]) {
    try {
      // Save to database
      const entities = this.traceRepository.create(spans);
      await this.traceRepository.save(entities);

      // Publish to Redis for real-time gateway
      // Group by session ID to publish efficiently
      const sessionGroups = new Map<string, TraceSpan[]>();
      
      for (const span of spans) {
        if (!sessionGroups.has(span.sessionId)) {
          sessionGroups.set(span.sessionId, []);
        }
        sessionGroups.get(span.sessionId)!.push(span);
      }

      for (const [sessionId, sessionSpans] of sessionGroups.entries()) {
        const channel = `session:${sessionId}:traces`;
        await this.redisService.publish(channel, JSON.stringify(sessionSpans));
      }

      return { success: true, count: spans.length };
    } catch (error) {
      this.logger.error(`Failed to ingest spans: ${error.message}`);
      throw error;
    }
  }

  async findBySession(sessionId: string): Promise<TraceSpan[]> {
    return this.traceRepository.find({
      where: { sessionId },
      order: { startedAt: 'ASC' },
    });
  }
}
