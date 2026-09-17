import { useEffect, useState } from "react";
import { loadAppState, saveAppState } from "../shared/storage";
import type { AppSettings, AppState } from "../shared/types";
import RowLayoutEditor from "./RowLayoutEditor";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "设置读取失败";
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadAppState()
      .then((loadedState) => {
        setState(loadedState);
        setDraft(loadedState.settings);
      })
      .catch((loadError: unknown) => setError(errorMessage(loadError)));
  }, []);

  useEffect(() => {
    if (!draft) {
      return;
    }
    document.documentElement.dataset.theme = draft.theme;
    document.documentElement.dataset.colorMode = draft.colorMode;
  }, [draft]);

  const updateDraft = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setSaved(false);
  };

  const save = async () => {
    if (!state || !draft) {
      return;
    }
    try {
      const latest = await loadAppState();
      await saveAppState({ ...latest, settings: draft });
      setState((current) => current ? { ...current, settings: draft } : current);
      setSaved(true);
      setError("");
    } catch (saveError: unknown) {
      setError(errorMessage(saveError));
      setSaved(false);
    }
  };

  if (error && !draft) {
    return <main className="page-shell centered-state"><span>{error}</span></main>;
  }

  if (!draft) {
    return <main className="page-shell centered-state"><div className="loading-spinner" /><span>正在读取设置…</span></main>;
  }

  return (
    <main className="page-shell options-shell">
      <header className="options-header">
        <p className="eyebrow">股票行情 · 设置</p>
        <h1>插件设置</h1>
        <p>调整行情刷新方式、颜色和股票列表布局。自选分组与股票关系会自动保存在当前浏览器中。</p>
      </header>

      <section className="settings-card">
        <h2>行情显示</h2>
        <div className="setting-row">
          <div className="setting-label"><strong>自动刷新间隔</strong><span>只刷新当前打开的分组</span></div>
          <select className="select-input" value={draft.refreshInterval} onChange={(event) => updateDraft("refreshInterval", Number(event.target.value))}>
            <option value={5}>每 5 秒</option>
            <option value={10}>每 10 秒（推荐）</option>
            <option value={30}>每 30 秒</option>
            <option value={60}>每 60 秒</option>
          </select>
        </div>
        <div className="setting-row">
          <div className="setting-label"><strong>涨跌颜色</strong><span>中国市场通常使用红涨绿跌</span></div>
          <select className="select-input" value={draft.colorMode} onChange={(event) => updateDraft("colorMode", event.target.value as AppSettings["colorMode"])}>
            <option value="china">中国市场（红涨绿跌）</option>
            <option value="western">国际市场（绿涨红跌）</option>
          </select>
        </div>
        <div className="setting-row">
          <div className="setting-label"><strong>界面主题</strong><span>跟随系统或固定使用明暗主题</span></div>
          <select className="select-input" value={draft.theme} onChange={(event) => updateDraft("theme", event.target.value as AppSettings["theme"])}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
      </section>

      <RowLayoutEditor layout={draft.rowLayout} onChange={(layout) => updateDraft("rowLayout", layout)} />

      <section className="settings-card">
        <h2>数据说明</h2>
        <p className="options-note">股票基础信息、分组关系和设置使用 Chrome 本地存储，不需要登录。实时行情只保留在运行时缓存中，不会长期写入本地数据。</p>
        <p className="options-note">支持沪深京 A 股普通股票与分时、日 K、周 K 走势图；暂不包含基金、ETF、港股、美股和交易。</p>
      </section>

      <div className="options-actions">
        {error ? <span className="options-error">{error}</span> : saved ? <span className="saved-indicator">设置已保存</span> : <span />}
        <button className="primary-button" type="button" onClick={() => void save()}>保存设置</button>
      </div>
    </main>
  );
}
