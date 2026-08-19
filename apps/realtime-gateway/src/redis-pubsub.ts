import { Redis } from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

export class RedisPubSub {
  private subscriber: Redis;
  private publisher: Redis;
  private messageCallback?: (channel: string, message: string) => void;

  constructor() {
    this.subscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    this.publisher = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

    this.subscriber.on('message', (channel, message) => {
      if (this.messageCallback) {
        this.messageCallback(channel, message);
      }
    });

    this.subscriber.on('error', (err) => {
      console.error('Redis Subscriber Error:', err);
    });

    this.publisher.on('error', (err) => {
      console.error('Redis Publisher Error:', err);
    });
  }

  subscribe(channel: string) {
    this.subscriber.subscribe(channel, (err, count) => {
      if (err) {
        console.error(`Failed to subscribe to ${channel}:`, err);
      } else {
        console.log(`Subscribed to ${channel}. Total subscriptions: ${count}`);
      }
    });
  }

  unsubscribe(channel: string) {
    this.subscriber.unsubscribe(channel, (err, count) => {
      if (err) {
        console.error(`Failed to unsubscribe from ${channel}:`, err);
      } else {
        console.log(`Unsubscribed from ${channel}. Total subscriptions: ${count}`);
      }
    });
  }

  publish(channel: string, data: any) {
    this.publisher.publish(channel, JSON.stringify(data));
  }

  onMessage(callback: (channel: string, message: string) => void) {
    this.messageCallback = callback;
  }
}
