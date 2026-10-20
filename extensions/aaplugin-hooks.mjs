
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = [{"id":"session-start","event":"SessionStart","timeout":30000}];
const extensionFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(extensionFile), '..');
const events = {
  SessionStart: 'session_start',
  SessionEnd: 'session_shutdown',
  UserPromptSubmit: 'input',
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  PreCompact: 'session_before_compact',
  PostCompact: 'session_compact',
  Stop: 'agent_end',
};

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


export default function aapluginHooks(pi) {
  for (const hook of hooks) {
    const nativeEvent = events[hook.event];
    if (!nativeEvent) continue;
    pi.on(nativeEvent, async (event, context) => {
      const input = { ...event, session_id: context?.sessionManager?.getSessionId?.() ?? '', cwd: context?.cwd || process.cwd(), hook_event_name: hook.event };
      if (!matches(hook, input)) return undefined;
      const handler = path.join(packageRoot, 'extensions', "aaplugin-hooks", hook.id, 'handler.mjs');
      const result = await executeHook(hook, handler, 'pi', input, { cwd: input.cwd, pluginRoot: packageRoot, pluginData: path.join(packageRoot, '.pi-data') });
      if (!result) return undefined;
      if (hook.event === 'SessionStart' && result.additionalContext)
        pi.sendMessage({ customType: 'aaplugin-hook', content: result.additionalContext, display: false }, { triggerTurn: false });
      if (hook.event === 'PreToolUse' && result.decision === 'deny')
        return { block: true, reason: result.reason || 'Blocked by aaplugin Hook.' };
      if (hook.event === 'UserPromptSubmit' && result.decision === 'deny')
        return { action: 'handled' };
      return undefined;
    });
  }
}
