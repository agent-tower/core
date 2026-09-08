/** Keep the dev launcher alive until the backend confirms its own cleanup. */
export function stopBackendAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    let finished = false;
    const done = () => {
      finished = true;
      clearTimeout(timer);
      child.removeListener('error', retry);
      resolve();
    };
    const retry = () => {
      if (finished || timer) return;
      timer = setTimeout(() => { timer = undefined; request(); }, 500);
    };
    const request = () => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      try {
        if (child.connected) {
          child.send({ type: 'agent-tower:shutdown' }, (error) => { if (error) retry(); });
        } else if (process.platform !== 'win32') {
          if (!child.kill('SIGTERM')) retry();
        } else {
          retry();
        }
      } catch { retry(); }
    };
    child.once('exit', done);
    child.on('error', retry);
    request();
  });
}
