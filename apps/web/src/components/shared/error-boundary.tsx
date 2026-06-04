'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Fallback label for the section that crashed */
  label?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-widget error boundary.
 * One widget crash doesn't kill the entire page.
 * Shows "Something went wrong" + Retry button.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to console in development
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-8 text-center">
          <AlertTriangle className="h-8 w-8 text-[var(--color-warning)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Something went wrong
              {this.props.label && (
                <span className="text-[var(--color-muted)]"> in {this.props.label}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              This section encountered an error. Try refreshing.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={this.handleRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
