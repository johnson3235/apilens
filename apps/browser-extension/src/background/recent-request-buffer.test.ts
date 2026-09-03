import { describe, expect, it } from 'vitest';
import type { CapturedRequest } from '@apilens/shared-types';
import { RecentRequestBuffer } from './recent-request-buffer';

const request = (id: string, originId = '1') => ({ id, originId } as CapturedRequest);

describe('RecentRequestBuffer', () => {
  it('tracks active-tab traffic without requiring a QA session', () => {
    const buffer = new RecentRequestBuffer();
    buffer.add(7, request('one'));
    expect(buffer.get(7).map((item) => item.id)).toEqual(['one']);
    expect(buffer.get(8)).toEqual([]);
  });

  it('deduplicates updates and keeps only the newest bounded traffic', () => {
    const buffer = new RecentRequestBuffer(2);
    buffer.add(7, request('one'));
    buffer.add(7, request('two'));
    buffer.add(7, request('one', 'updated'));
    buffer.add(7, request('three'));
    expect(buffer.get(7).map((item) => item.id)).toEqual(['one', 'three']);
    expect(buffer.get(7)[0]?.originId).toBe('updated');
  });

  it('clears traffic when its browser tab closes', () => {
    const buffer = new RecentRequestBuffer();
    buffer.add(7, request('one'));
    buffer.clear(7);
    expect(buffer.get(7)).toEqual([]);
  });
});
