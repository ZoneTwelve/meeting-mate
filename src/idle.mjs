export function hasActiveMeeting(status) {
  if (status?.recordingTestRunning || status?.pendingJoinUrl || ['testing', 'queued'].includes(status?.state)) return true;
  return status?.meetings?.some((meeting) => meeting.recordingFile || meeting.joinedAt || meeting.joinRequestedAt ||
    meeting.joinInFlight || meeting.pendingAttempt || meeting.stepping ||
    ['checking', 'joining', 'waiting_approval', 'starting_recording', 'recording', 'paused', 'finalizing'].includes(meeting.state)) ?? false;
}
