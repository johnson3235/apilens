import type { CapturedRequest } from '@apilens/shared-types';

/** Tab-scoped traffic used by the popup even when no evidence session exists. */
export class RecentRequestBuffer {
  private readonly byTab = new Map<number, Map<string, CapturedRequest>>();

  constructor(private readonly limit = 250) {}

  add(tabId: number, request: CapturedRequest): void {
    const bucket = this.byTab.get(tabId) ?? new Map<string, CapturedRequest>();
    bucket.delete(request.id);
    bucket.set(request.id, request);
    while (bucket.size > this.limit) bucket.delete(bucket.keys().next().value!);
    this.byTab.set(tabId, bucket);
  }

  get(tabId: number): CapturedRequest[] {
    return [...(this.byTab.get(tabId)?.values() ?? [])];
  }

  clear(tabId: number): void {
    this.byTab.delete(tabId);
  }
}
