/** download.js — file saving and object URL lifecycle (revokes URLs). */

const createdUrls = new Set();

function trackUrl(url) {
  createdUrls.add(url);
  return url;
}

/** Trigger a browser download for a Blob. Revokes the URL afterwards. */
export function downloadBlob(blob, filename) {
  const url = trackUrl(URL.createObjectURL(blob));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next task so the download has definitely started.
  setTimeout(() => releaseUrl(url), 2000);
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

export function downloadJSON(data, filename) {
  downloadText(JSON.stringify(data, null, 2), filename, 'application/json;charset=utf-8');
}

export function releaseUrl(url) {
  if (createdUrls.delete(url)) URL.revokeObjectURL(url);
}

/** Release every object URL we created (call on page teardown). */
export function releaseAllUrls() {
  for (const url of [...createdUrls]) URL.revokeObjectURL(url);
  createdUrls.clear();
}

/** Pick a file through the native file picker (allowed browser capability). */
export function pickFile(accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      file ? resolve(file) : reject(new DOMException('No file selected', 'AbortError'));
    }, { once: true });
    // 'cancel' is not universally supported; focus loss is handled by escape key user action.
    input.addEventListener('cancel', () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    input.click();
  });
}
