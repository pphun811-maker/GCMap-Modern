import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 顶层错误边界：渲染期异常不再卸载整树白屏，保留可读的恢复入口。
 *  语言在此层不可得（App 尚未挂载），中英并列。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[GCMap] render error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <b>页面出了点问题 · Something went wrong</b>
        <span className="error-boundary-msg">{this.state.error.message}</span>
        <button type="button" className="sb-go" onClick={() => location.reload()}>
          刷新页面 · Reload
        </button>
      </div>
    );
  }
}
