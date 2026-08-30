function childError(label, signal, cause) {
  return new Error(`${label} could not be signaled with ${signal}`, { cause });
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} did not exit within ${timeoutMs}ms`);
}

function waitFor(promise, timeoutMs, label, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = timers.setTimeout(
      () => finish(undefined, timeoutError(label, timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    );
  });
}

export function childLifecycle(
  child,
  timers = { setTimeout, clearTimeout },
) {
  let resolveExit;
  let rejectExit;
  const exited = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exited.catch(() => {});

  const finishExit = (code, signal) => resolveExit([code, signal]);
  child.once("exit", finishExit);
  child.once("error", rejectExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    finishExit(child.exitCode, child.signalCode);
  }

  const wait = (timeoutMs, label) => waitFor(exited, timeoutMs, label, timers);
  const stop = async (signal, timeoutMs, label) => {
    let signalFailure;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (!child.kill(signal)) {
          signalFailure = childError(label, signal, new Error("kill returned false"));
        }
      } catch (error) {
        signalFailure = childError(label, signal, error);
      }
    }
    try {
      return await wait(timeoutMs, label);
    } catch (error) {
      if (!signalFailure) throw error;
      throw new AggregateError(
        [signalFailure, error],
        `${label} could not be terminated`,
      );
    }
  };

  return { exited, wait, stop };
}

export async function cleanupChild(lifecycle, timeoutMs, label, primaryError) {
  try {
    await lifecycle.stop("SIGKILL", timeoutMs, label);
  } catch (error) {
    if (primaryError !== undefined) return;
    throw error;
  }
}
