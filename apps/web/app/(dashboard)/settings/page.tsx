import { PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { KeyForm, type KeyStatus } from './key-form';

export const dynamic = 'force-dynamic';

const KEYS: Record<string, { label: string; help: React.ReactNode; whenMissing: string }> = {
  AI_API_KEY: {
    label: 'OpenAI API key',
    help: 'Powers Katale AI on WhatsApp, the Agent console and the Overview assistant.',
    whenMissing: 'Without it, the AI features are switched off.',
  },
  AG_STUDIO_LICENSE_KEY: {
    label: 'AG Studio licence key',
    help: 'Licenses the Overview dashboard. It is also sent to browsers, as AG Studio requires.',
    whenMissing: 'Without it, the Overview shows an evaluation watermark.',
  },
};

export default async function SettingsPage() {
  const result = await apiGet<KeyStatus[]>('/api/settings/keys');
  return (
    <>
      <PageHeader
        title="API keys"
        description="Stored encrypted and applied immediately, with no restart. Saved keys can't be viewed again, only replaced. A key saved here is used instead of the one in the server's .env."
      />
      {result.ok ? (
        <div className="max-w-2xl space-y-4">
          {result.data.map((status) => {
            const key = KEYS[status.name];
            return key ? <KeyForm key={status.name} status={status} {...key} /> : null;
          })}
        </div>
      ) : (
        <p role="alert" className="max-w-2xl rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          {result.error}
        </p>
      )}
    </>
  );
}
