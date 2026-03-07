import React from "react";
import FlashMaster from "./FlashMaster";

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#060A16",
          color: "#E2E8F0",
          padding: 24,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 760,
            margin: "48px auto",
            background: "#111825",
            border: "1px solid #1A2135",
            borderRadius: 16,
            padding: 24,
          }}
        >
          <h1 style={{ margin: "0 0 12px", fontSize: 24 }}>Screen Error</h1>
          <p style={{ margin: "0 0 16px", color: "#94A3B8", lineHeight: 1.5 }}>
            The app hit a runtime error. The message below should help isolate the failing screen.
          </p>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#0C1020",
              borderRadius: 12,
              padding: 16,
              overflow: "auto",
            }}
          >
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <FlashMaster />
    </AppErrorBoundary>
  );
}
