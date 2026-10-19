"use client";
import { Component, type ReactNode } from "react";

/** Keeps a failure in one part of the UI (e.g. one object) from taking down the whole editor. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (error: Error, reset: () => void) => ReactNode; resetKey?: unknown }, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    // retry automatically when the watched value changes (e.g. the object was edited)
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error) {
    console.error("Editor component error:", error);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ? (
        this.props.fallback(this.state.error, () => this.setState({ error: null }))
      ) : (
        <div className="absolute inset-0 grid place-items-center rounded border border-dashed border-danger/60 bg-danger/5 p-1 text-center text-[10px] text-danger">
          Could not display this item
        </div>
      );
    }
    return this.props.children;
  }
}
