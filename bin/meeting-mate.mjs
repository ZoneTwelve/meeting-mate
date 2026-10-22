#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createApiClient } from '../src/api-client.mjs';
import { normalizeConfig } from '../src/config.mjs';

const help = `Meeting Mate — control an existing local service (Node.js 22+)

Usage: meeting-mate [--project /absolute/project/path] <command>

  join <meetURL>                 Request admission, then record after joining
  status                         Show service and meeting states
  stop [meetURL]                  Finalize recording and leave
  pause [meetURL]                 Finalize this segment, stay in the call
  resume [meetURL]                Start another recording segment
  recordings [limit]              List recordings (default 50; maximum 100)
  recording <recordingID>         Read recording metadata
  transcript <recordingID> [--speakers N] [--language auto|zh|en]
                                 Queue local transcription (N: 1–20)
  transcripts list [limit]        List transcription jobs
  transcripts get <jobUUID>       Read job status/result and download links
  help                           Show this help without reading configuration

Project: --project, then MEETING_MATE_PROJECT, then the current directory.
Reads that project's config.json and .env; connects only to 127.0.0.1.
Commands print JSON. Exit codes: 0 success, 1 service/config error, 2 usage.
Queued is not completed. Speaker labels are voice groups, not real names.
`;

class UsageError extends Error {}
const usage = (message) => { throw new UsageError(message); };
function integer(value, maximum, name) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > maximum) usage(`${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}

function parse(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--project', '--speakers', '--language'].includes(arg)) {
      if (Object.hasOwn(flags, arg) || !args[i + 1] || args[i + 1].startsWith('--')) usage(`Provide ${arg} once with a value.`);
      flags[arg] = args[++i];
    } else if (arg.startsWith('-')) usage(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, ...values] = positional;
  if (command !== 'transcript' && (flags['--speakers'] || flags['--language'])) usage('--speakers and --language are only valid for transcript.');
  const arity = (minimum, maximum = minimum) => {
    if (values.length < minimum || values.length > maximum) usage(`Invalid arguments for ${command}. Run meeting-mate help.`);
  };
  let invoke;
  switch (command) {
    case 'help': arity(0); break;
    case 'join': arity(1); invoke = (api) => api.join(values[0]); break;
    case 'status': arity(0); invoke = async (api) => {
      const [health, result] = await Promise.all([api.health(), api.meetings()]);
      return { health, meetings: result.meetings };
    }; break;
    case 'stop': case 'pause': case 'resume':
      arity(0, 1); invoke = (api) => api[command](values[0]); break;
    case 'recordings': {
      arity(0, 1);
      const limit = values[0] === undefined ? 50 : integer(values[0], 100, 'limit');
      invoke = (api) => api.recordingsList(limit); break;
    }
    case 'recording': arity(1); invoke = (api) => api.recordingGet(values[0]); break;
    case 'transcript': {
      arity(1);
      const numSpeakers = flags['--speakers'] === undefined ? undefined : integer(flags['--speakers'], 20, 'speakers');
      const language = flags['--language'];
      if (language !== undefined && !/^(auto|[a-z]{2,3})$/.test(language)) usage('language must be auto or a lowercase language code.');
      invoke = (api) => api.transcriptCreate({ recordingId: values[0],
        ...(numSpeakers === undefined ? {} : { numSpeakers }), ...(language === undefined ? {} : { language }) });
      break;
    }
    case 'transcripts':
      if (values[0] === 'list') {
        arity(1, 2);
        const limit = values[1] === undefined ? 50 : integer(values[1], 100, 'limit');
        invoke = (api) => api.transcriptsList(limit);
      } else if (values[0] === 'get') {
        arity(2); invoke = (api) => api.transcriptGet(values[1]);
      } else usage('Use transcripts list [limit] or transcripts get <jobUUID>.');
      break;
    default: usage('Unknown command. Run meeting-mate help.');
  }
  return { project: flags['--project'] ?? process.env.MEETING_MATE_PROJECT ?? process.cwd(), invoke };
}

async function projectConfig(project) {
  if (!path.isAbsolute(project)) usage('--project / MEETING_MATE_PROJECT must be an absolute local path.');
  let base;
  try {
    base = await realpath(project);
    if (!(await stat(base)).isDirectory()) throw new Error();
  } catch { throw new Error('Project directory does not exist. Use --project /absolute/project/path.'); }
  let raw, env = {};
  try {
    raw = JSON.parse(await readFile(path.join(base, 'config.json'), 'utf8'));
    try { env = parseEnv(await readFile(path.join(base, '.env'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return normalizeConfig(raw, { ...env, ...process.env }, base);
  } catch {
    // Do not echo configuration values, meeting codes, or .env contents on failure.
    throw new Error('Invalid or missing project config.json / .env. Check config.example.json and set MEET_USERNAME.');
  }
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h') || (args.length === 1 && args[0] === 'help')) {
    process.stdout.write(help);
  } else {
    const { project, invoke } = parse(args);
    if (!invoke) process.stdout.write(help);
    else {
      const result = await invoke(createApiClient(await projectConfig(project)));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`meeting-mate: ${error.message}\n`);
  process.exitCode = error instanceof UsageError || error.code === 'invalid_arguments' ? 2 : 1;
}
