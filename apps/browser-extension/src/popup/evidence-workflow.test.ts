import { describe, expect, it, vi } from 'vitest';
import type { EvidenceScenario, QaSession } from '@apilens/shared-types';
import { createEvidenceScenario, screenshotCount, setEvidenceScenarioStatus } from './evidence-workflow';

describe('evidence scenario workflow', () => {
  it('creates a trimmed active scenario', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'scenario-1' });
    expect(createEvidenceScenario('  Active plan  ', '  Allowance is visible  ', 100)).toEqual({
      id: 'scenario-1', title: 'Active plan', expectedResult: 'Allowance is visible', actualResult: '',
      status: 'in-progress', startedAt: 100, endedAt: null, notes: '',
    });
    vi.unstubAllGlobals();
  });

  it('requires a scenario title and finalizes result timing', () => {
    expect(() => createEvidenceScenario(' ', '')).toThrow(/title/i);
    const scenarios: EvidenceScenario[] = [{ id: 'a', title: 'A', expectedResult: '', actualResult: '', status: 'in-progress', startedAt: 100, endedAt: null, notes: '' }];
    expect(setEvidenceScenarioStatus(scenarios, 'a', 'passed', 250)[0]).toMatchObject({ status: 'passed', endedAt: 250 });
  });

  it('counts all screenshots or only those attached to one scenario', () => {
    const session = { markers: [
      { id: '1', kind: 'screenshot', label: 'one', timestamp: 1, detail: null, resourceRef: 'data:image/png;base64,x', scenarioId: 'a' },
      { id: '2', kind: 'screenshot', label: 'two', timestamp: 2, detail: null, resourceRef: 'data:image/png;base64,y', scenarioId: 'b' },
      { id: '3', kind: 'note', label: 'note', timestamp: 3, detail: null, resourceRef: null },
    ] } as QaSession;
    expect(screenshotCount(session)).toBe(2);
    expect(screenshotCount(session, 'a')).toBe(1);
  });
});
