import type { EvidenceScenario, EvidenceScenarioStatus, QaSession } from '@apilens/shared-types';

export function createEvidenceScenario(title: string, expectedResult: string, now = Date.now()): EvidenceScenario {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error('Scenario title is required.');
  return {
    id: crypto.randomUUID(),
    title: cleanTitle,
    expectedResult: expectedResult.trim(),
    actualResult: '',
    status: 'in-progress',
    startedAt: now,
    endedAt: null,
    notes: '',
  };
}

export function setEvidenceScenarioStatus(
  scenarios: EvidenceScenario[],
  scenarioId: string,
  status: EvidenceScenarioStatus,
  now = Date.now(),
): EvidenceScenario[] {
  if (!scenarios.some((scenario) => scenario.id === scenarioId)) throw new Error('Scenario no longer exists.');
  return scenarios.map((scenario) => scenario.id === scenarioId
    ? {
        ...scenario,
        status,
        startedAt: status === 'in-progress' ? (scenario.startedAt ?? now) : scenario.startedAt,
        endedAt: status === 'in-progress' || status === 'not-run' ? null : now,
      }
    : scenario);
}

export function screenshotCount(session: QaSession | null, scenarioId?: string): number {
  if (!session) return 0;
  return session.markers.filter((marker) => marker.kind === 'screenshot' && (scenarioId === undefined || marker.scenarioId === scenarioId)).length;
}
