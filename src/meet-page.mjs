// This function runs in the Meet tab. All controls must be visible and enabled.
export function meetPage(operation = 'snapshot', value = '') {
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const enabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const label = (element) => (element.getAttribute('aria-label') || element.innerText || '').trim();
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const find = (pattern) => buttons.find((element) => enabled(element) && pattern.test(label(element)));
  const name = [...document.querySelectorAll('input')].find((element) => visible(element) &&
    /^(your name|name|你的名稱|您的姓名|你的姓名|您的名稱|你的名字|姓名|名称|你的名字)$/i.test((element.getAttribute('aria-label') || element.placeholder || '').trim()));
  if (operation === 'name') {
    if (!name || !enabled(name)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(name, value);
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('change', { bubbles: true }));
    return name.value === value;
  }
  if (operation === 'dismissCameraNotice') {
    const dismiss = () => {
      const notice = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
        .find((element) => visible(element) && /Others may see your video differently/i.test(element.innerText || ''));
      const acknowledge = [...(notice?.querySelectorAll('button,[role="button"]') || [])]
        .find((element) => visible(element) && enabled(element) && /^Got it$/i.test(label(element)));
      if (!acknowledge) return false;
      acknowledge.click();
      return true;
    };
    // The notice can be inserted after cameraOn has already returned.
    if (!globalThis.__meetingMateCameraNoticeObserver && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(dismiss);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'aria-hidden'] });
      globalThis.__meetingMateCameraNoticeObserver = observer;
    }
    return dismiss();
  }
  const patterns = {
    join: /^(ask to join|join now|join meeting|立即加入|要求加入|请求加入|申請加入|申请加入)$/i,
    leave: /^(leave call|leave the call|離開通話|退出通話|退出通话|離開會議|离开通话)/i,
    microphoneOff: /^(turn off microphone|mute microphone|關閉麥克風|关闭麦克风)/i,
    microphoneOn: /^(turn on microphone|unmute microphone|開啟麥克風|开启麦克风|打开麦克风)/i,
    cameraOff: /^(turn off camera|關閉攝影機|关闭摄像头|關閉相機)/i,
    cameraOn: /^(turn on camera|開啟攝影機|开启摄像头|打开摄像头|開啟相機)/i,
  };
  if (operation === 'title') { document.title = value; return true; }
  if (patterns[operation]) {
    const control = find(patterns[operation]);
    if (!control) return false;
    control.click();
    return true;
  }
  const body = document.body?.innerText ?? '';
  const controls = buttons.map(label);
  // A visible leave control is stronger evidence than chat text containing words like "Ask to join".
  let phase = 'loading';
  if (find(patterns.leave)) phase = 'in_call';
  else if (/you('ve| have) been removed|you can.t join|was denied|request.*denied|meeting.*ended|you left the meeting|已遭移除|無法加入|无法加入|會議已結束|会议已结束|已離開會議/i.test(body)) phase = 'ended';
  else if (/asking to be let in|waiting for (someone|the host)|you.ll join (the call|the meeting) when|someone.*let you in|等待.*(允許|允许|加入)|正在要求加入|已提出加入要求/i.test(body)) phase = 'waiting_approval';
  else if (find(patterns.join) || name) phase = 'prejoin';
  else if (location.hostname === 'accounts.google.com' || /sign in|登入|登录/i.test(body)) phase = 'needs_login';
  const mic = find(patterns.microphoneOff) ? 'on' : find(patterns.microphoneOn) ? 'off' :
    controls.some((text) => /microphone problem|microphone.*permission|麥克風.*權限/i.test(text)) ? 'blocked' : 'unknown';
  const camera = find(patterns.cameraOff) ? 'on' : find(patterns.cameraOn) ? 'off' :
    controls.some((text) => /camera problem|camera.*permission|攝影機.*權限/i.test(text)) ? 'blocked' : 'unknown';
  // Meet's visible People button carries a hidden accessible label plus a
  // numeric badge. It is stronger evidence than unrelated text in chat.
  const peopleButton = buttons.find((element) => (element.getAttribute('aria-labelledby') || '').split(/\s+/).some((id) =>
    /^(people|participants|members|與會者|參與者|参加者|參加者|人員|人员)$/i.test(document.getElementById(id)?.textContent?.trim() || '')));
  const badge = peopleButton?.innerText?.trim().match(/^(?:\D*\s)?([1-9]\d{0,2})(?:\s\D*)?$/)?.[1];
  const countFromBadge = badge ? Number(badge) : null;
  const countFromData = [...document.querySelectorAll('[data-participant-count]')].map((element) => Number(element.getAttribute('data-participant-count'))).find((count) => count >= 1);
  const people = countFromBadge ?? countFromData ?? null;
  return { url: location.href, title: document.title, phase, hasNameInput: !!name, name: name?.value ?? null,
    microphone: mic, camera, controls, participantCount: people,
    alone: people === 1 || (people === null && /you.re the only one here|no one else is here|目前只有你|只有您一人/i.test(body)) };
}

export class MeetPage {
  constructor(cdp) { this.cdp = cdp; }
  run(operation, value = '') { return this.cdp.evaluate(`(${meetPage.toString()})(${JSON.stringify(operation)},${JSON.stringify(value)})`); }
  snapshot() { return this.run('snapshot'); }
  async prepare(username) {
    let snapshot = await this.snapshot();
    if (snapshot.phase !== 'prejoin') return snapshot;
    if (snapshot.hasNameInput && snapshot.name !== username) {
      if (!await this.run('name', username)) throw new Error('Could not fill the guest name');
    }
    if (snapshot.microphone === 'on') await this.run('microphoneOff');
    if (snapshot.camera === 'on') await this.run('cameraOff');
    snapshot = await this.snapshot();
    if (!['off', 'blocked'].includes(snapshot.microphone) || !['off', 'blocked'].includes(snapshot.camera)) {
      throw new Error('Cannot verify microphone/camera are off before joining');
    }
    return snapshot;
  }
}
