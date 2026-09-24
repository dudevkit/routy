/**
 * Clipboard write that works on the address this app is actually used from.
 *
 * `navigator.clipboard` only exists in a secure context, and the dashboard is routinely
 * opened over plain HTTP at a LAN address (`http://192.168.1.230:8010`) from a phone or a
 * second machine — not loopback, not TLS. There, `navigator.clipboard` is `undefined`, the
 * `?.` call short-circuits to nothing, and a caller that then shows its "copied" tick is
 * reporting a copy that never happened. `document.execCommand("copy")` still works in an
 * insecure context, so it is the fallback rather than the exception path.
 *
 * Returns whether the value is provably on the clipboard.
 */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // A refused permission prompt is not fatal: fall through and try the legacy path.
    }
  }
  return legacyCopy(value);
}

function legacyCopy(value: string): boolean {
  const area = document.createElement("textarea");
  area.value = value;
  area.readOnly = true;
  // Off-screen, never display:none — an unrendered element cannot be selected.
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);

  // Restore the user's own selection afterwards; stealing it is a visible side effect.
  const sel = document.getSelection();
  const restore = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  let copied = false;
  try {
    area.focus();
    // iOS Safari ignores .select() on a textarea unless the range is set explicitly.
    area.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  if (restore && sel) {
    sel.removeAllRanges();
    sel.addRange(restore);
  }
  document.body.removeChild(area);
  return copied;
}
