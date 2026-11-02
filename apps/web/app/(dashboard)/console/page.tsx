import { PageHeader } from '@/components/ui';
import { Console } from './console';

export default function ConsolePage() {
  return (
    <>
      <PageHeader
        title="Agent console"
        description="Talk to Katale AI through the same pipeline WhatsApp uses — handy for development and demos without a phone."
      />
      <Console />
    </>
  );
}
