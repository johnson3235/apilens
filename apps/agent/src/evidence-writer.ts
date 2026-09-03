import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceEnvironmentInfo, EvidenceFormat } from '@apilens/shared-types';
import { buildEvidenceBundle, renderArtifacts } from '@apilens/evidence';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import { AGENT_VERSION } from './config';
import type { SessionStore } from './store';

export interface WrittenFile {
  format: string;
  path: string;
  bytes: number;
}

const VALID_FORMATS: EvidenceFormat[] = ['json', 'har', 'markdown', 'html'];

/** Writes evidence artifacts to disk, always with redaction applied. */
export class EvidenceWriter {
  constructor(
    private readonly store: SessionStore,
    private readonly defaultOutputDir: string,
  ) {}

  async export(sessionId: string, formats: string[], outputDir: string | null): Promise<WrittenFile[]> {
    const record = this.store.get(sessionId);
    if (!record) throw new Error(`Session ${sessionId} is not known to this agent.`);

    const requested = formats.filter((format): format is EvidenceFormat =>
      VALID_FORMATS.includes(format as EvidenceFormat),
    );
    if (requested.length === 0) throw new Error(`No supported formats requested. Supported: ${VALID_FORMATS.join(', ')}.`);

    const environment: EvidenceEnvironmentInfo = {
      environmentId: record.session.environmentId,
      environmentName: record.session.environmentId,
      browser: null,
      userAgent: record.session.userAgent,
      platform: process.platform,
      extensionVersion: 'agent-export',
      agentVersion: AGENT_VERSION,
    };

    const bundle = buildEvidenceBundle({
      session: record.session,
      requests: this.store.requests(sessionId),
      spans: this.store.spans(sessionId),
      rules: record.rules,
      environment,
      redactionPolicy: DEFAULT_REDACTION_POLICY,
      options: { formats: requested },
    });

    const artifacts = renderArtifacts(bundle, { formats: requested });
    const target = join(outputDir ?? this.defaultOutputDir, sessionId);
    mkdirSync(target, { recursive: true });

    return artifacts.map((artifact, index) => {
      const path = join(target, artifact.fileName);
      writeFileSync(path, artifact.content, 'utf8');
      return { format: requested[index] ?? 'json', path, bytes: Buffer.byteLength(artifact.content, 'utf8') };
    });
  }
}
