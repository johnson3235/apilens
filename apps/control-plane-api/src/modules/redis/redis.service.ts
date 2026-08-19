import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_HOST, REDIS_PORT } from '../../common/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;

  onModuleInit() {
    this.publisher = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
    });
  }

  onModuleDestroy() {
    this.publisher.disconnect();
  }

  async publish(channel: string, message: string) {
    return this.publisher.publish(channel, message);
  }
}
