const json = (schema) => ({ 'application/json': { schema } });
const object = { type: 'object', additionalProperties: true };
const response = (description, schema = object) => ({ description, content: json(schema) });
const url = { type: 'string', format: 'uri', example: 'https://meet.google.com/abc-defg-hij' };
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const idempotency = { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 128 }, description: 'Optional retry key; retained for up to one hour in this service process (maximum 200 keys).' };
const control = (action, required = false) => ({ post: {
  operationId: `meeting_${action}`, summary: `${action} a meeting`, parameters: [idempotency],
  requestBody: { required: true, content: json({ type: 'object', properties: { url }, ...(required ? { required: ['url'] } : {}) }) },
  responses: { 200: response('Already in the requested state'), 202: response('Action queued; inspect meeting status for completion'), 400: response('Invalid input'), 409: response('Busy or incompatible state'), 503: response('Service unavailable') },
} });
export function apiSpec(port = 8787) {
  return {
    openapi: '3.1.0', info: { title: 'Meeting Mate Local API', version: '1.0.0', description: 'Local macOS meeting recorder. Loopback only; browser Origin requests are rejected.' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      '/healthz': { get: { operationId: 'health', responses: { 200: response('Service and meeting status') } } },
      '/v1/meetings': { get: { operationId: 'meetings_list', responses: { 200: response('Tracked meetings') } } },
      '/v1/meetings/join': control('join', true),
      '/v1/meetings/stop': control('stop'),
      '/v1/meetings/pause': control('pause'),
      '/v1/meetings/resume': control('resume'),
      '/v1/recordings': { get: { operationId: 'recordings_list', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], responses: { 200: response('Recordings ordered newest first') } } },
      '/v1/recordings/{id}': { get: { operationId: 'recording_get', parameters: [idParameter], responses: { 200: response('Recording metadata, local path and download URL'), 404: response('Not found') } } },
      '/v1/recordings/{id}/file': { get: { operationId: 'recording_download', parameters: [idParameter, { name: 'Range', in: 'header', schema: { type: 'string' } }], responses: {
        200: { description: 'Verified MP4', content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } },
        206: { description: 'Single byte range' }, 404: response('Not found'), 409: response('File is not finalized'), 416: response('Invalid byte range'),
      } } },
      '/v1/diagnostics': { get: { operationId: 'recorder_diagnostics', responses: { 200: response('Dependency, permission and disk checks; inspect ok') } } },
      '/v1/recording-tests': { post: { operationId: 'recording_test_start', parameters: [idempotency], requestBody: { required: true, content: json({ type: 'object' }) }, responses: { 202: response('Synthetic recording test started'), 409: response('Meeting or test is active') } } },
      '/v1/recording-tests/{id}': { get: { operationId: 'recording_test_status', parameters: [{ ...idParameter, description: 'Test ID or latest' }], responses: { 200: response('Test state and validation report'), 404: response('Test not found') } } },
      '/v1/transcripts': {
        get: { operationId: 'transcripts_list', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], responses: { 200: response('Transcript jobs, newest first') } },
        post: { operationId: 'transcript_create', parameters: [idempotency], requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['recordingId'], properties: {
          recordingId: { type: 'string' }, language: { type: 'string', default: 'auto' }, numSpeakers: { type: 'integer', minimum: 1, maximum: 20 },
        } }) }, responses: { 202: response('Local transcript job queued or existing job returned'), 400: response('Invalid options'), 409: response('Session is active or recordings are not verified') } },
      },
      '/v1/transcripts/{id}': { get: { operationId: 'transcript_get', parameters: [idParameter], responses: { 200: response('Job and completed timestamped, speaker-labeled result'), 404: response('Not found') } } },
      '/v1/transcripts/{id}/file': { get: { operationId: 'transcript_download', parameters: [idParameter, { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'txt', 'srt', 'vtt'], default: 'txt' } }], responses: { 200: { description: 'UTF-8 transcript file' }, 404: response('Not found'), 409: response('Transcript is not complete') } } },
    },
  };
}
