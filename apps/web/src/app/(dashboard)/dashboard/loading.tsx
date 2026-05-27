import { Skeleton } from '@/components/ui/skeleton';

// Static page titles are rendered by each page component itself, so
// we deliberately do NOT skeleton the heading here, that pattern made
// known-static text appear to "load," which read as broken. Each page
// handles its own data-dependent isLoading state and skeletons only
// the panels that actually depend on a fetch.
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading content">
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
