import { verifyPerspectives } from '../concepts/verify.mjs';

export function verifySeminar(record, config, options = {}) {
  return verifyPerspectives({ runId: record.seminarId, createdAt: record.createdAt,
    agents: record.result.selected.map(s => ({ codexName: s.agent })) }, config, { ...options, markerPrefix: '研讨' });
}
