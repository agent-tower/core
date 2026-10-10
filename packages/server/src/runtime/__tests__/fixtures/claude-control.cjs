const readline = require('node:readline');
const fs = require('node:fs');
const mode = process.argv[2] || 'normal';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  fs.appendFileSync('received.txt', (frame.request?.subtype || frame.type) + '\n');
  if (frame.type === 'control_request') {
    if (mode === 'modehang' && frame.request.subtype === 'set_permission_mode') return;
    const response = frame.request.subtype === 'set_permission_mode' ? { mode: 'default' } : {};
    send({ type: 'control_response', response: { subtype: mode === 'modefail' && frame.request.subtype === 'set_permission_mode' ? 'error' : 'success', request_id: frame.request_id, response } });
  } else if (frame.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: 'native-session', permissionMode: 'default' });
    if (mode === 'eof') { process.exit(0); return; }
    if (mode === 'tail') { process.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })); return; }
    if (mode === 'result' || mode === 'delayed-tail') { send({ type: 'result', subtype: 'success', result: 'done' }); return; }
    if (mode === 'cancel-pending' || mode === 'cancel-running') {
      const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      descendant.once('message', () => {
        fs.writeFileSync('old-processes.json', JSON.stringify([process.pid, descendant.pid]));
        send({ type: 'control_request', request_id: 'native', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool', input: { command: 'printf approved > action.txt' } } });
      });
      return;
    }
    send({ type: 'control_request', request_id: 'native', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool', input: { command: 'printf approved > action.txt' } } });
    // These frames must be consumed while the first request remains unanswered.
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reader stays active' }] } });
    send({ type: 'control_request', request_id: 'cancelled', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'cancelled-tool', input: { command: 'second' } } });
    send({ type: 'control_cancel_request', request_id: 'cancelled' });
  } else if (frame.type === 'control_response') {
    if (frame.response.request_id !== 'native') throw new Error('wrong native request');
    if (mode === 'cancel-running' && frame.response.response.behavior === 'allow') {
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'action is running' }] } });
      setTimeout(() => { fs.writeFileSync('action.txt', 'approved'); send({ type: 'result', subtype: 'success', result: 'done' }); }, 30_000);
      return;
    }
    if (frame.response.response.behavior === 'allow') fs.writeFileSync('action.txt', 'approved');
    send({ type: 'result', subtype: 'success', result: 'done' });
  }
}).on('close', () => {
  if (mode === 'delayed-tail') {
    setTimeout(() => process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'tail after logical completion' }] } }) + '\n', () => process.exit(0)), 400);
  } else process.exit(0);
});
