import { Component, type ReactNode } from 'react';

/** Keeps a rendering bug in one tab from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('EarthQL UI error', error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="state">
        <h3>Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</h3>
        <pre className="sql" style={{ maxWidth: 720, textAlign: 'left' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
