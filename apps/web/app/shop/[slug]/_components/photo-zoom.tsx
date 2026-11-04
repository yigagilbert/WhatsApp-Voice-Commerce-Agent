'use client';

import { useRef } from 'react';
import s from '../shop.module.css';

/** The product photo. Tapping it opens the full-size image. */
export function PhotoZoom({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className={s.zoomButton}
        onClick={() => dialog.current?.showModal()}
        aria-label={`View a larger photo of ${alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- served at its final size */}
        <img src={src} alt={alt} fetchPriority="high" width={1000} height={1000} />
      </button>
      <dialog
        ref={dialog}
        className={s.zoom}
        aria-label={alt}
        onClick={() => dialog.current?.close()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- served at its final size */}
        <img src={src} alt="" />
        <button type="button" className={s.iconButton} aria-label="Close photo">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="m3 3 10 10M13 3 3 13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </dialog>
    </>
  );
}
