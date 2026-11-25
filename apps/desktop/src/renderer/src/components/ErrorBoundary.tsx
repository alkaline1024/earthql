import { Component, type ReactNode } from 'react';
import { useApp } from '../store';

/** Offers recovery for rendering failures without restarting the app. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('EarthQL UI error', error, info.componentStack);
  }
  backToHome = () => {
    // Preserve connections, tabs and unsaved drafts while leaving the broken view.
    useApp.setState({ screen: 'connections', editProfileId: undefined, draggedTabId: null });
    this.setState({ error: null });
  };
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="state" role="alert">
        <h3>Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</h3>
        <pre className="sql" style={{ maxWidth: 720, textAlign: 'left' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
        <p>Your tabs and unsaved edits are kept when you return Home.</p>
        <div className="row">
          <button className="btn primary" onClick={this.backToHome}>Back to Home</button>
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
