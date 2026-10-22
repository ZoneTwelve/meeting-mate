// Preserve future checks across a graceful service restart, so installing a
// code update does not immediately send another admission request.
export function restoreSchedule(monitor, previous, now = Date.now()) {
  if (previous?.state !== 'stopped' || !Array.isArray(previous.meetings)) return;
  for (const job of monitor.jobs) {
    const saved = previous.meetings.find((meeting) => meeting.url === job.url);
    if (!saved) continue;
    if (saved.lastRecording?.file) job.lastRecording = saved.lastRecording;
    if (Number.isFinite(saved.nextCheckAt) && saved.nextCheckAt > now) {
      job.nextCheckAt = Math.min(saved.nextCheckAt, now + monitor.config.pollIntervalMs);
    }
  }
}
