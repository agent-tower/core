const readline = require('node:readline');
const fs = require('node:fs');
const mode = process.argv[2] || 'normal';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const params = { threadId: 'native-thread', turnId: 'native-turn', itemId: 'tool' };
const item = { id: 'tool', type: 'commandExecution', command: 'printf approved > action.txt', cwd: process.cwd(), status: 'inProgress' };
const notify = (method, extra) => send({ method, params: { threadId: 'native-thread', turnId: 'native-turn', ...extra } });
const finish = () => {
  notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } });
  notify('turn/completed', { turn: { id: 'native-turn', status: 'completed' } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync('received.txt', (m.method || 'decision') + '\n');
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (mode === 'modehang') return;
    if (mode === 'modefail') { send({ id: m.id, error: { message: 'policy denied' } }); return; }
    send({ id: m.id, result: { thread: { id: 'native-thread' }, approvalPolicy: mode === 'wrongmode' ? 'never' : 'on-request', approvalsReviewer: m.params.approvalsReviewer, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } } });
  } else if (m.method === 'turn/start') {
    notify('turn/started', { turn: { id: 'native-turn' } });
    send({ id: m.id, result: { turn: { id: 'native-turn' } } });
    if (mode === 'eof') { process.exit(0); return; }
    if (mode === 'tail') { process.stdout.end(JSON.stringify({ method: 'turn/completed', params: { ...params, turn: { id: 'native-turn', status: 'completed' } } })); return; }
    if (mode === 'result' || mode === 'delayed-tail') { finish(); return; }
    const request = () => {
      notify('item/started', { item });
      send({ id: 0, method: 'item/commandExecution/requestApproval', params: { ...params, command: item.command } });
      notify('item/started', { item: { type: 'agentMessage', id: 'text', text: '' } });
      notify('item/agentMessage/delta', { itemId: 'text', delta: 'reader stays active' });
      send({ id: 'cancelled', method: 'item/commandExecution/requestApproval', params: { ...params, itemId: 'cancelled-tool' } });
      notify('serverRequest/resolved', { requestId: 'cancelled' });
    };
    if (mode.startsWith('cancel-')) {
      const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      descendant.once('message', () => { fs.writeFileSync('old-processes.json', JSON.stringify([process.pid, descendant.pid])); request(); });
    } else request();
  } else if (m.id === 0 && m.result) {
    notify('serverRequest/resolved', { requestId: 0 });
    if (mode === 'cancel-running' && m.result.decision === 'accept') {
      notify('item/agentMessage/delta', { itemId: 'text', delta: 'action is running' });
      setTimeout(() => { fs.writeFileSync('action.txt', 'approved'); finish(); }, 30000); return;
    }
    if (m.result.decision === 'accept') fs.writeFileSync('action.txt', 'approved');
    notify('item/completed', { item: { ...item, status: m.result.decision === 'accept' ? 'completed' : 'declined', exitCode: 0, aggregatedOutput: 'tool output' } });
    finish();
  }
}).on('close', () => {
  if (mode === 'delayed-tail') setTimeout(() => {
    notify('item/completed', { item: { type: 'agentMessage', id: 'tail', text: 'tail after logical completion' } }); process.exit(0);
  }, 400);
  else process.exit(0);
});
