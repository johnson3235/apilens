import { useState, useMemo } from 'react';
import { CapturedRequest } from '@apilens/shared-types/request';
import { TraceSpan } from '@apilens/shared-types/trace';

export function useTimeline(requests: CapturedRequest[], traces: TraceSpan[]) {
  const timeline = useMemo(() => {
    // combine and sort
    return [...requests].sort((a, b) => a.timestamp - b.timestamp);
  }, [requests, traces]);

  return { timeline, services: [] };
}
