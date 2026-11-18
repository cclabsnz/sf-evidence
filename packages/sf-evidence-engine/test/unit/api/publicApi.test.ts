import * as api from '../../../src/index.js';

/**
 * The engine's runtime surface: everything the CLI package re-exports for read-only consumers
 * (the licensed add-on), plus the collection path, which hosts that write archives need. The
 * AWS edition's Lambda host is built against exactly these names.
 */
const CLI_SURFACE = [
  'ALGORITHM', 'ALGORITHM_EXPLANATION', 'ANCHOR_STATEMENTS', 'ArchiveReader', 'EXIT',
  'GENESIS_PREV', 'GitSink', 'LocalSink', 'UnsupportedValueError',
  'anchorStatementsFor', 'assessStatus', 'canonicalBytes', 'canonicalize', 'formatStatus',
  'formatVerifyReport', 'hasRecordedDegradation', 'manifestHash',
  'merkleRoot', 'resolveEvaluateAnchor', 'setExitCode', 'sha256Hex', 'verifyChain',
  'verifyExitCode',
];

/** Coverage assessment behind `status`: what is missing, how long until it is gone, and the exit code. */
const STATUS_ASSESSMENT = ['assessCoverage', 'statusExit'];

/** Environment diagnostics behind `doctor`; every external dependency is injected through DoctorEnv. */
const DIAGNOSTICS = ['doctorExitCode', 'formatChecks', 'runChecks'];

const COLLECTION_PATH = [
  'API_VERSION', 'COLLECTORS', 'ORG_ID_QUERY', 'ORG_INFO_QUERY', 'buildBatch', 'buildExplanation',
  'classifyDegradation', 'collectionClock', 'getCollector', 'resolveCollectBounds', 'resolveOrgId',
  'resolveOrgInfo', 'resolveSince', 'runCollect',
];

/** Read-only record-file resolution, view definitions and the DuckDB view compiler behind `query`. */
const QUERY = ['VIEWS', 'compileDuckdbViews', 'isOrgId', 'resolveQueryFiles'];

/** `--archive` / `--sink` resolution shared by every plugin that takes those flags. */
const SINK_RESOLUTION = ['DEFAULT_ARCHIVE', 'resolveSink', 'resolveSinks'];

describe('engine public API', () => {
  it('exports the CLI surface, the status assessment and the collection path, and nothing else', () => {
    expect(Object.keys(api).sort()).toEqual([...CLI_SURFACE, ...STATUS_ASSESSMENT, ...COLLECTION_PATH, ...DIAGNOSTICS, ...QUERY, ...SINK_RESOLUTION].sort());
  });
});
