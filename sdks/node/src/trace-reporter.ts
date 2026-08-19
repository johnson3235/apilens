import { TraceSpan } from '@apilens/shared-types';

export class TraceReporter {
  private spans: TraceSpan[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private reporterUrl: string;
  private readonly BATCH_SIZE = 50;

  constructor(reporterUrl?: string) {
    this.reporterUrl = reporterUrl || 'http://localhost:3001';
    this.flushInterval = setInterval(() => this.flush(), 2000);
    this.flushInterval.unref(); // Don't block process exit
  }

  public addSpan(span: TraceSpan) {
    this.spans.push(span);
    if (this.spans.length >= this.BATCH_SIZE) {
      this.flush();
    }
  }

  public async flush() {
    if (this.spans.length === 0) return;

    const batch = [...this.spans];
    this.spans = [];

    await this.sendWithRetry(batch);
  }

  private async sendWithRetry(batch: TraceSpan[], retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.reporterUrl}/api/v1/traces/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch),
        });

        if (response.ok) return;
        
        if (attempt === retries) {
          console.error(`[ApiLens] Failed to report ${batch.length} spans. HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt === retries) {
          console.error(`[ApiLens] Failed to report ${batch.length} spans:`, error);
        }
      }

      // Exponential backoff
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  public shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    return this.flush();
  }
}
