import Link from 'next/link';

/** Shown when a link from the Overview opened a page narrowed to the records that need action. */
export function FilteredView({
  label,
  count,
  clearHref,
}: {
  label: string;
  count: number;
  clearHref: string;
}) {
  return (
    <p
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-900"
    >
      <span>
        Showing {count} {count === 1 ? 'record' : 'records'}: {label}
      </span>
      <Link href={clearHref} className="font-medium underline-offset-2 hover:underline">
        Show all
      </Link>
    </p>
  );
}
