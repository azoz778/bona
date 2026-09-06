// SIGTERM handling: never kill the process in the middle of a git push or a sharp encode.
// The unit gives us TimeoutStopSec=45, so we wait up to 40 s for the in-flight job and then
// exit; a job that is still running after that is genuinely wedged and systemd would have
// SIGKILLed us anyway.
export const STOP_GRACE_MS = 40000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {() => boolean} isBusy
 * @returns {Promise<boolean>} true when the worker went idle before the deadline
 */
export async function waitForIdle(isBusy, { timeoutMs = STOP_GRACE_MS, pollMs = 250, sleepImpl = sleep, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  while (isBusy() && now() < deadline) await sleepImpl(pollMs);
  return !isBusy();
}
