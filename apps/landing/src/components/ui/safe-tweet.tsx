"use client";

import { Component, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Tweet } from "react-tweet";

// `react-tweet` crashes during render when Twitter's syndication
// response omits one of the entity arrays it expects
// (hashtags / user_mentions / urls / symbols). Its internal
// `l1` helper does `for (const n of entities.hashtags)` without
// a falsy guard, so an undefined entity array throws
// "r is not iterable" and, without a boundary, bubbles up to
// the route-level error UI ("This page couldn't load").
//
// SafeTweet renders <Tweet> inside a class-component error
// boundary so a single broken tweet falls back to a "View on
// X" link instead of taking down the whole page.

interface SafeTweetProps {
  id: string;
}

interface SafeTweetState {
  hasError: boolean;
}

export class SafeTweet extends Component<SafeTweetProps, SafeTweetState> {
  state: SafeTweetState = { hasError: false };

  static getDerivedStateFromError(): SafeTweetState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    if (typeof console !== "undefined") {
      console.warn("SafeTweet caught:", error);
    }
  }

  componentDidUpdate(prev: Readonly<SafeTweetProps>): void {
    if (prev.id !== this.props.id && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <a
            href={`https://x.com/i/status/${this.props.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-bg-secondary px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:border-accent-border hover:text-accent-primary"
          >
            View tweet on X
            <ArrowUpRight className="size-3.5 opacity-70" />
          </a>
        </div>
      );
    }

    return <Tweet id={this.props.id} />;
  }
}
