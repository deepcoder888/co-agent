import { verifyPerspectives } from '../concepts/verify.mjs';
import { codexName } from './runner.mjs';

export function verifyCouncil(record, config, options = {}) {
  return verifyPerspectives({ runId: record.sessionId, createdAt: record.createdAt,
    agents: record.memberSnapshot.map(a => ({ codexName: codexName(a) })) }, config, { ...options, markerPrefix: '顾问团' });
}
