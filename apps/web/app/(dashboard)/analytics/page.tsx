import { redirect } from 'next/navigation';

/** Analytics now lives on the Overview; this keeps old bookmarks and links working. */
export default function AnalyticsPage() {
  redirect('/overview');
}
