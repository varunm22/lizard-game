/** A small controls hint in the corner; fades once the player starts moving. */
export function createHud(): { hideHint(): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;transition:opacity 1.5s;pointer-events:none';
  el.textContent = 'W/S move · A/D turn · Shift run · Space jump · drag or Q/E orbit · wheel zoom';
  document.body.appendChild(el);
  return {
    hideHint() {
      el.style.opacity = '0';
    },
  };
}
