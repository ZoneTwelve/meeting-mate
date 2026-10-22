import http from 'node:http';
import { meetUrl } from './config.mjs';

export const API_TIMEOUT_MS = 10_000;
export const API_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// The transcript service permits a 20 MiB result plus job metadata. MCP bounds
// inline transcript output separately and returns download references for more.
export const API_MAX_TRANSCRIPT_RESPONSE_BYTES = 22 * 1024 * 1024;
export const API_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
export const API_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const API_TRANSCRIPT_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const API_TRANSCRIPT_LANGUAGE_PATTERN = /^(?:auto|[a-z]{2,3})$/;
export const RECORDINGS_MAX_LIMIT = 100;
export const TRANSCRIPTS_MAX_LIMIT = 100;

export class ApiError extends Error {
  constructor(code, message, { httpStatus, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code, message: this.message,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

function validId(id) {
  if (typeof id !== 'string' || !API_ID_PATTERN.test(id)) {
    throw new ApiError('invalid_arguments', 'Use an ID returned by the API, not a file path or URL.');
  }
  return encodeURIComponent(id);
}

function meetingBody(url, required = false) {
  if (url === undefined && !required) return {};
  if (typeof url !== 'string' || url.length > 2048) {
    throw new ApiError('invalid_arguments', 'Provide a Google Meet URL such as https://meet.google.com/abc-defg-hij.');
  }
  try { return { url: meetUrl(url) }; }
  catch { throw new ApiError('invalid_arguments', 'Provide a valid HTTPS Google Meet URL.'); }
}

function transcriptBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['recordingId', 'language', 'numSpeakers'].includes(key))) {
    throw new ApiError('invalid_arguments', 'Provide recordingId and optional language and numSpeakers only.');
  }
  const { recordingId, language, numSpeakers } = input;
  validId(recordingId);
  if (language !== undefined && (typeof language !== 'string' || !API_TRANSCRIPT_LANGUAGE_PATTERN.test(language))) {
    throw new ApiError('invalid_arguments', 'language must be auto or a lowercase two- or three-letter ISO language code.');
  }
  if (numSpeakers !== undefined && (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > 20)) {
    throw new ApiError('invalid_arguments', 'numSpeakers must be an integer from 1 to 20.');
  }
  return { recordingId, ...(language === undefined ? {} : { language }), ...(numSpeakers === undefined ? {} : { numSpeakers }) };
}

function transcriptId(id) {
  if (typeof id !== 'string' || !API_TRANSCRIPT_ID_PATTERN.test(id)) {
    throw new ApiError('invalid_arguments', 'Use a transcript job UUID returned by transcript_create or transcripts_list.');
  }
  return encodeURIComponent(id);
}

function apiMessage(value) {
  if (typeof value?.error === 'string') return value.error;
  if (typeof value?.error?.message === 'string') return value.error.message;
  if (typeof value?.message === 'string') return value.message;
  if (typeof value?.status === 'string') return value.status;
  return 'Request failed';
}

// Deliberately expose named operations, not a generic URL/path request method.
// Native HTTP pins every connection to IPv4 loopback and never follows redirects
// or uses an environment-configured HTTP proxy.
export function createApiClient(config, { timeoutMs = API_TIMEOUT_MS } = {}) {
  const port = config?.healthPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('healthPort must be an integer from 1 to 65535');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');

  function request(method, pathname, body, { signal, idempotencyKey } = {}, maxResponseBytes = API_MAX_RESPONSE_BYTES) {
    if (idempotencyKey !== undefined && (method !== 'POST' || typeof idempotencyKey !== 'string' || !API_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))) {
      throw new ApiError('invalid_arguments', 'idempotencyKey must contain 1–128 letters, digits, dots, underscores, colons or hyphens, and is only valid for POST operations.');
    }
    const statusTool = pathname === '/v1/transcripts' ? 'transcripts_list or transcript_get' : 'meet_status or recording_test_status';
    const uncertain = method === 'POST'
      ? ` The service may have accepted the request; check ${statusTool} before retrying.` : '';
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: pathname, method, agent: false, signal,
        headers: {
          accept: 'application/json',
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      }, (res) => {
        const chunks = [];
        let bytes = 0;
        const httpStatus = res.statusCode;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            req.destroy(new ApiError('response_too_large', `Local API response exceeded ${maxResponseBytes / 1024 ** 2} MiB.`, { httpStatus }));
          } else {
            chunks.push(chunk);
          }
        });
        res.once('error', () => reject(new ApiError('invalid_response', `Local API response was interrupted.${uncertain}`, { httpStatus })));
        res.once('end', () => {
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handled below */ }
          const isObject = result !== null && typeof result === 'object' && !Array.isArray(result);
          if (httpStatus < 200 || httpStatus >= 300) {
            const message = httpStatus >= 300 && httpStatus < 400 ? 'Redirects are not allowed' : isObject ? apiMessage(result) : 'Expected a JSON error response';
            reject(new ApiError('http_error', `Meeting Mate API returned HTTP ${httpStatus}: ${message}`, {
              httpStatus, ...(isObject ? { details: result } : {}),
            }));
          } else if (!isObject) {
            reject(new ApiError('invalid_response', `Meeting Mate API did not return a JSON object.${uncertain}`, { httpStatus }));
          } else if (result.accepted === false) {
            reject(new ApiError('request_rejected', apiMessage(result), { httpStatus, details: result }));
          } else {
            resolve(result);
          }
        });
      });
      const timer = setTimeout(() => req.destroy(new ApiError('request_timeout', `Local API request timed out after ${timeoutMs} ms.${uncertain}`)), timeoutMs);
      timer.unref();
      req.once('close', () => clearTimeout(timer));
      req.once('error', (error) => {
        if (error instanceof ApiError) { reject(error); return; }
        if (error.name === 'AbortError') {
          reject(new ApiError('request_aborted', `Local API request was cancelled.${uncertain}`));
        } else if (error.code === 'ECONNREFUSED') {
          reject(new ApiError('service_unavailable', `Meeting Mate is not reachable at 127.0.0.1:${port}. Start the local service with pnpm run install:launchd.`));
        } else {
          reject(new ApiError('connection_error', `Could not communicate with the local Meeting Mate service (${error.code ?? 'network error'}).${uncertain}`));
        }
      });
      req.end(payload);
    });
  }

  return Object.freeze({
    health: (options) => request('GET', '/healthz', undefined, options),
    meetings: (options) => request('GET', '/v1/meetings', undefined, options),
    join: (url, options) => request('POST', '/v1/meetings/join', meetingBody(url, true), options),
    stop: (url, options) => request('POST', '/v1/meetings/stop', meetingBody(url), options),
    pause: (url, options) => request('POST', '/v1/meetings/pause', meetingBody(url), options),
    resume: (url, options) => request('POST', '/v1/meetings/resume', meetingBody(url), options),
    recordingsList: (limit = 50, options) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > RECORDINGS_MAX_LIMIT) {
        throw new ApiError('invalid_arguments', `limit must be an integer from 1 to ${RECORDINGS_MAX_LIMIT}.`);
      }
      return request('GET', `/v1/recordings?limit=${limit}`, undefined, options);
    },
    recordingGet: (id, options) => request('GET', `/v1/recordings/${validId(id)}`, undefined, options),
    recordingTestStart: (options) => request('POST', '/v1/recording-tests', {}, options),
    recordingTestStatus: (id = 'latest', options) => request('GET', `/v1/recording-tests/${validId(id)}`, undefined, options),
    transcriptCreate: (input, options) => request('POST', '/v1/transcripts', transcriptBody(input), options),
    transcriptsList: (limit = 50, options) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > TRANSCRIPTS_MAX_LIMIT) {
        throw new ApiError('invalid_arguments', `limit must be an integer from 1 to ${TRANSCRIPTS_MAX_LIMIT}.`);
      }
      return request('GET', `/v1/transcripts?limit=${limit}`, undefined, options);
    },
    transcriptGet: (id, options) => request('GET', `/v1/transcripts/${transcriptId(id)}`, undefined, options, API_MAX_TRANSCRIPT_RESPONSE_BYTES),
    diagnostics: (options) => request('GET', '/v1/diagnostics', undefined, options),
  });
}
