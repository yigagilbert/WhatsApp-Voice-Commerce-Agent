/**
 * Keeps what someone typed when their session ends mid-save. Held only in this tab's session
 * storage, only until the form next opens, and never for passwords or files: forms with those
 * don't pass a draft key to useFormAction.
 */
const PREFIX = 'katale-draft:';
const MAX_AGE_MS = 60 * 60 * 1000;

export interface FormDraft {
  savedAt: number;
  values: Record<string, string[]>;
}

export function draftFromForm(form: FormData, now = Date.now()): FormDraft {
  const values: Record<string, string[]> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string' || name.startsWith('$ACTION')) continue;
    (values[name] ??= []).push(value);
  }
  return { savedAt: now, values };
}

/** Null for anything unreadable or too old to be what the person still means to save. */
export function parseDraft(raw: string | null, now = Date.now()): FormDraft | null {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as Partial<FormDraft>;
    if (typeof draft.savedAt !== 'number' || now - draft.savedAt > MAX_AGE_MS) return null;
    if (!draft.values || typeof draft.values !== 'object') return null;
    return { savedAt: draft.savedAt, values: draft.values };
  } catch {
    return null;
  }
}

export function saveDraft(key: string, form: FormData): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(draftFromForm(form)));
  } catch {
    // Storage can be blocked or full: the form simply starts empty after signing in.
  }
}

export function takeDraft(key: string): FormDraft | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    window.sessionStorage.removeItem(PREFIX + key);
    return parseDraft(raw);
  } catch {
    return null;
  }
}

const NOT_RESTORED = new Set(['hidden', 'file', 'password', 'submit', 'button']);

const setValue = (
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) => {
  if (el.value === value) return;
  // Through the prototype's setter, so React sees the change on controlled fields too.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

/** Puts a draft back into a form's fields. Fields sharing a name are filled in order. */
export function applyDraft(form: HTMLFormElement, draft: FormDraft): void {
  const seen = new Map<string, number>();
  for (const el of Array.from(form.elements)) {
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) ||
      !el.name ||
      el.disabled ||
      (el instanceof HTMLInputElement && NOT_RESTORED.has(el.type))
    )
      continue;
    const values = draft.values[el.name] ?? [];
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const wanted = values.includes(el.value);
      if (wanted !== el.checked && (el.type === 'checkbox' || wanted)) el.click();
      continue;
    }
    const index = seen.get(el.name) ?? 0;
    seen.set(el.name, index + 1);
    const value = values[index];
    if (value !== undefined) setValue(el, value);
  }
}
