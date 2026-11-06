'use client';

import { type FormEvent, useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { applyDraft, saveDraft, takeDraft } from '@/lib/form-draft';
import { isSessionEndedError } from '@/lib/session-ended';

/** A confirm-worthy submit returns the question; null lets it through. */
type ConfirmQuestion = (form: FormData) => string | null;

interface Options {
  /** Keeps typed values across a session ending mid-save. Never set it on password forms. */
  draftKey?: string;
  /** Clears the form after a successful save: for forms that create something new. */
  resetOnSuccess?: boolean;
  confirm?: ConfirmQuestion;
}

const succeeded = (state: unknown) =>
  typeof state === 'object' && state !== null && 'ok' in state && state.ok === true;

/**
 * useActionState for dashboard forms. A plain `<form action>` makes React reset every field after
 * the action, so a rejected save would wipe what was typed. This submits by hand instead, which
 * keeps the values. `action` stays on the form so it can't fall back to a GET, with values in the
 * URL, if it is submitted before the page's JavaScript has loaded.
 */
export function useFormAction<State>(
  action: (state: Awaited<State>, form: FormData) => State | Promise<State>,
  initial: Awaited<State>,
  { draftKey, resetOnSuccess, confirm }: Options = {},
) {
  const keepingDraft = async (state: Awaited<State>, form: FormData) => {
    try {
      return await action(state, form);
    } catch (error) {
      if (draftKey && isSessionEndedError(error)) saveDraft(draftKey, form);
      throw error;
    }
  };
  const [state, dispatch, pending] = useActionState<State, FormData>(
    draftKey ? (keepingDraft as typeof action) : action,
    initial,
  );
  const [, startSubmit] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const [restored, setRestored] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const question = confirm?.(form);
    if (question && !window.confirm(question)) return;
    startSubmit(() => dispatch(form));
  };

  useEffect(() => {
    if (resetOnSuccess && succeeded(state)) ref.current?.reset();
  }, [state, resetOnSuccess]);

  useEffect(() => {
    if (!draftKey || !ref.current) return;
    const draft = takeDraft(draftKey);
    if (!draft) return;
    const form = ref.current;
    applyDraft(form, draft);
    // Again once fields switched on by the first pass have appeared.
    setTimeout(() => applyDraft(form, draft), 50);
    setRestored(true);
  }, [draftKey]);

  return { state, pending, restored, formProps: { ref, action: dispatch, onSubmit } };
}

/** Tells someone back from signing in that the form holds their unsaved values. */
export function DraftRestored({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      This is what you typed before your session ended. It hasn&apos;t been saved yet: check it and
      save again.
    </p>
  );
}
