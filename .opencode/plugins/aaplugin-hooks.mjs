
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = [{"id":"session-start","event":"SessionStart","timeout":30000}];
const pluginFile = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(pluginFile), '../..');

function matches(hook, input) {
  if (!hook.matcher || hook.matcher === '*') return true;
  const subject = input.tool_name || input.toolName || input.tool?.name || '';
  return new RegExp(hook.matcher).test(subject);
}


const HOOK_INPUT_LIMIT = 1024 * 1024;
const HOOK_OUTPUT_LIMIT = 1024 * 1024;

function executeHook(hook, handler, platform, input, context) {
  let serialized;
  try {
    serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > HOOK_INPUT_LIMIT)
      return Promise.reject(new Error('aaplugin Hook failed: INPUT_TOO_LARGE.'));
  } catch {
    return Promise.reject(new Error('aaplugin Hook failed: INPUT_INVALID.'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('node', [handler, platform], {
        cwd: context.cwd,
        env: { ...process.env, PLUGIN_ROOT: context.pluginRoot, PLUGIN_DATA: context.pluginData },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error('aaplugin Hook failed: SPAWN_FAILED.'));
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let finished = false;
    const stop = code => {
      if (finished) return;
      failure ??= code;
      try { child.kill('SIGKILL'); } catch { /* Still close owned pipes and settle the failure. */ }
      finish(failure);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const timer = setTimeout(() => stop('TIMEOUT'), hook.timeout);
    const finish = (code, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code) reject(new Error('aaplugin Hook failed: ' + code + '.'));
      else resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failure) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > HOOK_OUTPUT_LIMIT) stop('OUTPUT_TOO_LARGE');
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > HOOK_OUTPUT_LIMIT) stop('OUTPUT_TOO_LARGE');
    });
    child.on('error', () => finish('SPAWN_FAILED'));
    child.stdin.on('error', () => stop('INPUT_FAILED'));
    child.on('close', code => {
      if (failure || code !== 0) {
        finish(failure || 'HANDLER_FAILED');
        return;
      }
      if (!stdout.trim()) {
        finish(undefined, undefined);
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result === null || typeof result !== 'object' || Array.isArray(result))
          throw new Error('invalid');
        finish(undefined, result);
      } catch {
        finish('OUTPUT_INVALID');
      }
    });
    child.stdin.end(serialized);
  });
}


async function run(event, input, output, directory) {
  const results = [];
  for (const hook of hooks.filter(candidate => candidate.event === event && matches(candidate, input))) {
    const handler = path.join(workspaceRoot, '.opencode', "aaplugin-hooks", hook.id, 'handler.mjs');
    const result = await executeHook(hook, handler, 'opencode', {
      ...input, session_id: input.session_id ?? input.sessionID ?? '', cwd: directory, hook_event_name: hook.event,
    }, { cwd: directory, pluginRoot: workspaceRoot, pluginData: path.join(workspaceRoot, '.opencode', 'data') });
    if (!result) continue;
    results.push(result);
    if (result.updatedInput && output && typeof output === 'object') output.args = result.updatedInput;
    if (result.additionalContext && output && Array.isArray(output.parts))
      output.parts.push({ type: 'text', text: result.additionalContext, synthetic: true });
    if (result.decision === 'deny' || result.decision === 'block'
      || (event === 'Stop' && result.decision === 'continue')
      || (event === 'SessionStart' && result.decision === 'stop'))
      throw new Error(result.reason || 'Blocked by aaplugin Hook.');
  }
  return results;
}

export default async function aapluginHooks(context = {}) {
  const directory = context.directory || workspaceRoot;
  const sessions = new Map();
  let disposed = false;
  const hasStartup = hooks.some(hook => hook.event === 'SessionStart');
  function startup(sessionID) {
    if (disposed || !hasStartup || typeof sessionID !== 'string' || !sessionID) return undefined;
    let state = sessions.get(sessionID);
    if (!state) {
      state = { ready: undefined };
      sessions.set(sessionID, state);
      state.ready = run('SessionStart', { session_id: sessionID, source: 'startup' }, undefined, directory)
        .then(results => results.map(result => result.additionalContext).filter(text => typeof text === 'string' && text.length > 0));
    }
    return state;
  }
  return {
    'experimental.chat.system.transform': async (input, output) => {
      const state = startup(input.sessionID);
      if (!state) return;
      const texts = await state.ready;
      if (sessions.get(input.sessionID) !== state) return;
      for (const text of texts) {
        if (!output.system.includes(text)) output.system.push(text);
      }
    },
    'chat.message': (input, output) => run('UserPromptSubmit', {
      ...input, prompt: (output.parts || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n'),
    }, output, directory),
    'tool.execute.before': (input, output) => run('PreToolUse', { ...input, tool_name: input.tool, tool_input: output.args, tool_use_id: input.callID }, output, directory),
    'tool.execute.after': (input, output) => run('PostToolUse', { ...input, tool_name: input.tool, tool_input: input.args, tool_use_id: input.callID, tool_response: output.output }, output, directory),
    event: async ({ event }) => {
      const sessionID = event?.properties?.info?.id ?? event?.properties?.sessionID;
      if (event?.type === 'session.created') {
        await startup(sessionID)?.ready;
        return;
      }
      if (event?.type === 'server.instance.disposed') {
        disposed = true;
        sessions.clear();
        return;
      }
      if (event?.type === 'session.deleted') sessions.delete(sessionID);
      const mapping = {
        'session.deleted': 'SessionEnd',
        'session.compacted': 'PostCompact',
        'session.idle': 'Stop',
      };
      const canonical = mapping[event?.type];
      if (canonical) await run(canonical, { ...event, session_id: sessionID ?? '' }, undefined, directory);
    },
  };
}
