/**
 * Overall system status banner, the hero section at the top of /status.
 * @module
 */

interface StatusBannerProps {
  readonly state: string;
}

const STATE_CONFIG: Record<string, { label: string; bgClass: string; iconPath: string }> = {
  operational: {
    label: 'All Systems Operational',
    bgClass: 'bg-[var(--color-success)]',
    iconPath: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  degraded: {
    label: 'Degraded Performance',
    bgClass: 'bg-[var(--color-warning)]',
    iconPath:
      'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  },
  partial_outage: {
    label: 'Partial System Outage',
    bgClass: 'bg-[var(--color-warning)]',
    iconPath:
      'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  },
  major_outage: {
    label: 'Major System Outage',
    bgClass: 'bg-[var(--color-danger)]',
    iconPath:
      'M12 9v3.75m0-10.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z',
  },
  maintenance: {
    label: 'Under Maintenance',
    bgClass: 'bg-[var(--color-accent)]',
    iconPath:
      'M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z',
  },
};

export function StatusBanner({ state }: StatusBannerProps) {
  const config = STATE_CONFIG[state] ?? {
    label: 'All Systems Operational',
    bgClass: 'bg-[var(--color-success)]',
    iconPath: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  };

  return (
    <div className={`${config.bgClass} rounded-[var(--radius-lg)] px-6 py-5 text-white`}>
      <div className="flex items-center gap-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={config.iconPath} />
        </svg>
        <h1 className="text-xl font-semibold">{config.label}</h1>
      </div>
    </div>
  );
}
