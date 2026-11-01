import { ErrorNotice, PageHeader, Section } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { dateTime } from '@/lib/format';
import {
  GenerateButton,
  OpenAdCard,
  RetryButton,
  SettingsForm,
  StatusPill,
  type StatusAd,
  type StatusSettings,
} from './status-forms';

export const dynamic = 'force-dynamic';

const HOW_TO = [
  'Download the image and copy the caption.',
  'On the shop phone, open WhatsApp › Updates › add a status, pick the image and paste the caption.',
  'Come back and press “I posted it” so the history stays accurate.',
];

export default async function StatusAdsPage() {
  const [settings, ads] = await Promise.all([
    apiGet<StatusSettings>('/api/status-ads/settings'),
    apiGet<StatusAd[]>('/api/status-ads'),
  ]);
  const header = (
    <PageHeader
      title="Status ads"
      description="Katale prepares WhatsApp Status adverts from your in-stock products, with your real photos and catalogue prices. You post them from your phone. Katale never posts statuses or messages customers for you."
    />
  );
  if (!settings.ok)
    return (
      <>
        {header}
        <ErrorNotice
          message={
            /not found/i.test(settings.error)
              ? 'Status ads are turned off on this server. Ask whoever runs Katale to set STATUS_ADS_ENABLED=true.'
              : settings.error
          }
        />
      </>
    );
  const s = settings.data;
  const list = ads.ok ? ads.data : [];
  const open = list.filter((a) => a.status === 'DRAFT' || a.status === 'READY');
  const history = list.filter((a) => a.status !== 'DRAFT' && a.status !== 'READY');
  const eligible = s.products.filter((p) => p.eligible).length;
  return (
    <>
      {header}
      <div className="max-w-4xl space-y-6">
        <Section title="How posting works">
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <ol className="list-decimal space-y-1 pl-5">
              {HOW_TO.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-slate-500">
              Who sees your status is set on your phone (Settings › Privacy › Status). Under “My
              contacts”, only people saved in the shop phone’s contacts see it, even if they saved
              your number.
            </p>
          </div>
        </Section>
        <Section title="Schedule">
          <p className="mb-3 text-sm text-slate-600">
            {s.enabled && s.nextAt
              ? `Next advert: ${dateTime(s.nextAt)} (${s.timezone ?? s.merchantTimezone}).`
              : 'Automatic preparation is off.'}{' '}
            {eligible} product{eligible === 1 ? '' : 's'} can be promoted now.{' '}
            {s.aiCopy
              ? 'Wording is written by AI and checked: no prices, discounts, offers or claims.'
              : 'Wording comes from built-in templates (AI is not configured).'}
          </p>
          <SettingsForm settings={s} />
        </Section>
        <Section title="Generate now">
          <GenerateButton />
        </Section>
        <Section title="To review and post">
          {!ads.ok ? (
            <ErrorNotice message={ads.error} />
          ) : !open.length ? (
            <p className="text-sm text-slate-600">Nothing waiting. Generate an advert above.</p>
          ) : (
            <ul className="space-y-4">
              {open.map((ad) => (
                <OpenAdCard key={ad.id} ad={ad} ctas={s.ctas} themes={s.themes} />
              ))}
            </ul>
          )}
        </Section>
        <Section title="History">
          {!history.length ? (
            <p className="text-sm text-slate-600">No posted, skipped or failed adverts yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {history.map((ad) => (
                <li key={ad.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                  <StatusPill status={ad.status} />
                  <span className="font-medium text-slate-900">
                    {ad.product?.name ?? 'No product'}
                  </span>
                  <span className="text-slate-500">
                    {ad.status === 'POSTED'
                      ? `posted ${dateTime(ad.postedAt)}${ad.postedBy ? ` by ${ad.postedBy}` : ''}`
                      : dateTime(ad.createdAt)}
                  </span>
                  {ad.status === 'POSTED' && ad.headline && (
                    <span className="text-slate-500">“{ad.headline}”</span>
                  )}
                  {ad.status === 'FAILED' && (
                    <>
                      <span className="text-xs text-rose-700">
                        {ad.lastError} (attempt {ad.attempts}
                        {ad.nextAttemptAt ? `; tries again ${dateTime(ad.nextAttemptAt)}` : ''})
                      </span>
                      <RetryButton id={ad.id} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
