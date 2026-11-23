import { classifyDegradation, salesforceErrorCode } from '../../../src/lib/errors.js';
import { sfApiError } from '../../fixtures/httpApiError.js';

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

describe('classifyDegradation remediation names the source permission', () => {
  it('keeps the audit-trail text byte-identical', () => {
    expect(classifyDegradation(apiError('INSUFFICIENT_ACCESS'), 'audit-trail')!.remediation).toBe(
      'Grant the running user the "View Setup and Configuration" permission, then re-run.',
    );
    expect(
      classifyDegradation(apiError('INSUFFICIENT_ACCESS_OR_READONLY'), 'audit-trail')!.remediation,
    ).toBe('Grant the running user the "View Setup and Configuration" permission, then re-run.');
    expect(classifyDegradation(apiError('INVALID_TYPE'), 'audit-trail')!.remediation).toBe(
      'The object is not available in this org or is not visible to the running user. Confirm the org edition and the "View Setup and Configuration" permission.',
    );
  });

  it.each(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_TYPE'])(
    'names Monitor Login History for login-history on %s',
    (code) => {
      const r = classifyDegradation(apiError(code), 'login-history')!.remediation;
      expect(r).toContain('Monitor Login History');
      expect(r).toContain('MonitorLoginHistory');
      expect(r).not.toContain('View Setup');
    },
  );
});

describe('classifyDegradation on the error shape jsforce actually throws', () => {
  // jsforce's HttpApiError carries errorCode and data but no statusCode. Before this was
  // recognised, every real permission or timeout error classified as null and failed the run.
  it.each(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_TYPE', 'INVALID_FIELD', 'QUERY_TIMEOUT', 'REQUEST_LIMIT_EXCEEDED'])(
    'classifies %s without a statusCode',
    (code) => {
      const err = sfApiError(code);
      expect('statusCode' in err).toBe(false);
      expect(classifyDegradation(err, 'login-history')).toMatchObject({ source: 'login-history', code, detail: err.message });
    },
  );

  it('still returns null for an unrecognised code in the same shape', () => {
    expect(classifyDegradation(sfApiError('UNKNOWN_EXCEPTION'), 'audit-trail')).toBeNull();
  });
});

describe('salesforceErrorCode', () => {
  it('reads errorCode from the jsforce shape and from the sf-core ApiError shape', () => {
    expect(salesforceErrorCode(sfApiError('INVALID_TYPE'))).toBe('INVALID_TYPE');
    expect(salesforceErrorCode(apiError('QUERY_TIMEOUT'))).toBe('QUERY_TIMEOUT');
  });

  it('is undefined for anything without a string errorCode', () => {
    expect(salesforceErrorCode(new Error('socket hang up'))).toBeUndefined();
    expect(salesforceErrorCode(Object.assign(new Error('x'), { errorCode: 42 }))).toBeUndefined();
    expect(salesforceErrorCode(Object.assign(new Error('x'), { errorCode: '' }))).toBeUndefined();
    expect(salesforceErrorCode(null)).toBeUndefined();
    expect(salesforceErrorCode('INVALID_TYPE')).toBeUndefined();
  });
});
