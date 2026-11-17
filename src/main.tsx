import { Component, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { configureAdsFromEnv } from './services/ads';
import { App } from './ui/App';
import './styles.css';

configureAdsFromEnv();

/** Last line of defence: a render error shows a recovery screen instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="loader" role="alert">
        <span>Something went wrong</span>
        <p className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{this.state.error.message}</p>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>Back to the lab</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
