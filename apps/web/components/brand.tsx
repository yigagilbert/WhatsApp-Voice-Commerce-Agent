import Image from 'next/image';
import logo from './katale-logo.png';

/** The Katale AI logo mark and name, coloured like the logo ("AI" in its green). */
export function Brand({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const large = size === 'lg';
  return (
    <span className="flex items-center gap-2">
      {/* Served as-is from /_next/static: the image optimizer isn't needed for a 14 KB mark. */}
      <Image
        src={logo}
        alt=""
        unoptimized
        preload
        className={large ? 'h-10 w-auto' : 'h-8 w-auto'}
      />
      <span
        className={`${large ? 'text-xl' : 'text-sm'} font-semibold tracking-tight text-slate-900`}
      >
        Katale <span className="text-green-700">AI</span>
      </span>
    </span>
  );
}
