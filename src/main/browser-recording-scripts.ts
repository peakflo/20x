/** Runs in a separate JavaScript world. Does not assign or change agent @refs. */
export const RECORDING_WORLD = 998
export const RECORDING_PREFIX = '__20X_RECORDING__'
const helpers = `
const interactiveSelector = 'a,button,input,select,textarea,[role],summary,[contenteditable]';
const cleanUrl = () => location.origin + location.pathname;
const sensitive = el => /password|secret|token|auth|credit|card|cvv|cvc|ssn|otp|one.time|verification|pin/i.test([el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '));
const safeText = (value, limit = 120) => String(value || '').replace(/(?:Bearer\\s+)?[a-zA-Z0-9_-]{32,}/g, '[redacted]').slice(0, limit);
const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width >= 2 && r.height >= 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0; };
const locator = el => {
  const tag = el.tagName.toLowerCase();
  if (sensitive(el)) return tag + (el.type ? '[type="' + CSS.escape(el.type) + '"]' : '');
  if (el.id) return '#' + CSS.escape(el.id);
  const testId = el.getAttribute('data-testid');
  if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
  if (el.name) return tag + '[name="' + CSS.escape(el.name) + '"]';
  const sameTag = el.parentElement ? Array.from(el.parentElement.children).filter(node => node.tagName === el.tagName) : [];
  return tag + (sameTag.length > 1 ? ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')' : '');
};
const describe = (el, knownIndex) => {
  const editable = ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable;
  const secret = sensitive(el);
  const label = el.getAttribute('aria-label') || (el.labels && el.labels[0]?.textContent) || el.getAttribute('placeholder') || (!editable ? el.textContent : '') || '';
  const index = knownIndex || Array.from(document.querySelectorAll(interactiveSelector)).filter(visible).indexOf(el) + 1;
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
    name: secret ? '[sensitive field]' : safeText(label), inputType: el.tagName === 'INPUT' ? el.type : undefined,
    value: editable ? (secret || el.type === 'file' || el.isContentEditable ? '[redacted]' : safeText(el.value)) : undefined,
    checked: el.type === 'checkbox' || el.type === 'radio' ? !!el.checked : undefined,
    index: index > 0 ? index : undefined, locator: safeText(locator(el), 160) };
};
const targetText = target => (target.index ? '#' + target.index + ' ' : '') + target.locator + ' | ' + [target.tag, target.role, target.name].filter(Boolean).join(':');
const snapshot = () => {
  const elements = [];
  const visibleElements = Array.from(document.querySelectorAll(interactiveSelector)).filter(visible);
  for (const el of visibleElements.slice(0, 120)) {
    elements.push(describe(el, elements.length + 1));
  }
  let text = (document.body?.innerText || '').slice(0, 10000);
  for (const el of document.querySelectorAll('input,textarea,[contenteditable]')) {
    if (sensitive(el)) { const value = el.value || el.textContent || ''; if (value) text = text.split(value).join('[redacted]'); }
  }
  return { url: cleanUrl(), elements, truncated: visibleElements.length > 120 || text.length > 4000, text: safeText(text, 4000) };
};`
export function buildRecordingSnapshotScript(): string { return `(() => { ${helpers} return snapshot(); })()` }
export function buildRecordingInstallScript(nonce: string): string {
  return `(() => {
if (globalThis.__recordingCleanup) globalThis.__recordingCleanup();
${helpers}
const emit = console.info.bind(console);
let pendingInput = null;
let inputTimer;
let lastScroll = 0;
const send = payload => emit(${JSON.stringify(RECORDING_PREFIX + nonce + ':')} + JSON.stringify(payload));
const flush = () => { clearTimeout(inputTimer); if (pendingInput) { send(pendingInput); pendingInput = null; } };
const handler = event => {
  if (!event.isTrusted) return;
  if (event.type === 'keydown' && !['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  const el = event.target instanceof Element ? event.target.closest('a,button,input,select,textarea,[role],summary,[contenteditable]') || event.target : null;
  const target = el ? describe(el) : null;
  const payload = { action: event.type === 'keydown' ? 'keydown:' + event.key : event.type,
    target: target ? targetText(target) : '', snapshot: snapshot() };
  if (event.type === 'scroll') { if (Date.now() - lastScroll < 250) return; lastScroll = Date.now(); payload.target = 'x=' + scrollX + ',y=' + scrollY; }
  if (event.type === 'input') { pendingInput = payload; clearTimeout(inputTimer); inputTimer = setTimeout(flush, 200); return; }
  flush();
  send(payload);
};
const events = ['click', 'input', 'change', 'submit', 'keydown', 'scroll'];
for (const type of events) document.addEventListener(type, handler, true);
window.addEventListener('pagehide', flush, true);
globalThis.__recordingCleanup = () => { flush(); send({ action: 'recording-flush-complete' }); window.removeEventListener('pagehide', flush, true); for (const type of events) document.removeEventListener(type, handler, true); delete globalThis.__recordingCleanup; };
return true;
})()`
}
export const RECORDING_REMOVE_SCRIPT = `(() => {
  if (typeof globalThis.__recordingCleanup !== 'function') return false;
  globalThis.__recordingCleanup();
  return true;
})()`

export function buildRecordingTargetScript(selector: string): string {
  return `(() => { ${helpers} const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return '[unknown target]'; return targetText(describe(el)); })()`
}
