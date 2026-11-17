import { classifyDegradation } from '../../../src/lib/errors.js';

function apiError(errorCode: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { errorCode, statusCode: 400, name: 'ApiError' });
}

describe('classifyDegradation', () => {
  it('treats INSUFFICIENT_ACCESS as a degradation with actionable remediation', () => {
    const d = classifyDegradation(apiError('INSUFFICIENT_ACCESS'), 'audit-trail');
    expect(d).toMatchObject({ source: 'audit-trail', code: 'INSUFFICIENT_ACCESS' });
    expect(d!.remediation).toMatch(/View Setup and Configuration/i);
  });

  it('matches the INSUFFICIENT_ACCESS_OR_READONLY variant', () => {
    expect(classifyDegradation(apiError('INSUFFICIENT_ACCESS_OR_READONLY'), 'audit-trail')).not.toBeNull();
  });

  it('treats INVALID_TYPE as a degradation (object not available in this org)', () => {
    const d = classifyDegradation(apiError('INVALID_TYPE'), 'audit-trail');
    expect(d?.code).toBe('INVALID_TYPE');
  });

  it('treats QUERY_TIMEOUT as a degradation, not a crash', () => {
    expect(classifyDegradation(apiError('QUERY_TIMEOUT'), 'audit-trail')?.code).toBe('QUERY_TIMEOUT');
  });

  it('returns null for an error that is not a known degradation, so it propagates', () => {
    // An unknown failure must not be quietly recorded as reduced coverage.
    expect(classifyDegradation(new Error('socket hang up'), 'audit-trail')).toBeNull();
  });
});
