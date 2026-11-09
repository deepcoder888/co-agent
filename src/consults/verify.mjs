import { verifyPerspectives } from '../concepts/verify.mjs';

export function verifyConsult(record, config, options = {}) {
  return verifyPerspectives({ runId: record.consultId, createdAt: record.createdAt,
    agents: record.result.lenses.map(s => ({ codexName: s.agent })) }, config, { ...options, markerPrefix: '会诊' });
}
