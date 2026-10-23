/** clipboard.js — copy with a document.execCommand fallback for older contexts. */

/**
 * @param {string} text
 * @returns {Promise<boolean>} true when the copy succeeded
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (permissions, insecure context, …).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copy and announce the result through the given announcer function.
 * Used by code-block copy buttons for accessible feedback.
 */
export async function copyWithFeedback(text, announce, successLabel = 'Copied') {
  const ok = await copyText(text);
  if (ok) announce?.(successLabel);
  else announce?.('Copy failed — select the text and copy manually');
  return ok;
}
