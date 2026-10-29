(() => {
  const notice = document.querySelector('#cookieConsentNotice');
  const acknowledge = document.querySelector('#cookieConsentAcknowledge');
  const storageKey = 'nutriCookieNoticeV1';
  if (!notice || !acknowledge) return;
  try { if (localStorage.getItem(storageKey) === '1') return; } catch {}
  notice.hidden = false;
  acknowledge.addEventListener('click', () => {
    try { localStorage.setItem(storageKey, '1'); } catch {}
    notice.hidden = true;
  });
})();
