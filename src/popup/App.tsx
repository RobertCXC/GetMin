import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { getEastmoneyUrl } from "../shared/eastmoney";
import {
  formatCompactAmount,
  formatPercent,
  formatPrice,
  formatSignedNumber,
  formatVolume,
  getTone,
  quoteStatusLabel
} from "../shared/formatters";
import { sendExtensionMessage } from "../shared/messages";
import {
  ALL_GROUP_ID,
  type AppState,
  type IntradayTrend,
  type KlineData,
  type KlinePeriod,
  type KlinePoint,
  type Quote,
  type RowField,
  type RowLayout,
  type Stock,
  type StockGroup
} from "../shared/types";
import {
  STORAGE_KEY,
  getStockIdsForGroup,
  getStockMemberships,
  loadAppState,
  normalizeState,
  saveAppState
} from "../shared/storage";

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stockMarketLabel(stock: Stock): string {
  return stock.kind === "etf" ? `${stock.market} · ETF` : stock.market;
}

function emptyQuote(stock: Stock, status: Quote["status"] = "empty"): Quote {
  return {
    secid: stock.id,
    code: stock.code,
    name: stock.name,
    market: stock.market,
    price: null,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    volume: null,
    amount: null,
    turnoverRate: null,
    pe: null,
    pb: null,
    marketCap: null,
    floatMarketCap: null,
    updatedAt: null,
    status
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function chartKey(secid: string, period: KlinePeriod): string {
  return `${secid}:${period}`;
}

const chartPeriods: Array<{ value: KlinePeriod; label: string; hint: string }> = [
  { value: "intraday", label: "分时", hint: "今日走势" },
  { value: "daily", label: "日 K", hint: "近 160 日" },
  { value: "weekly", label: "周 K", hint: "近 160 周" }
];

type StateUpdater = (state: AppState) => AppState;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [trends, setTrends] = useState<Record<string, IntradayTrend>>({});
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<Stock[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [view, setView] = useState<"list" | "detail">("list");
  const [detailStock, setDetailStock] = useState<Stock | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [chartPeriod, setChartPeriod] = useState<KlinePeriod>("intraday");
  const [chartData, setChartData] = useState<Record<string, KlineData>>({});
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState("");
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [addStock, setAddStock] = useState<Stock | null>(null);
  const [addStockGroupIds, setAddStockGroupIds] = useState<string[]>([]);
  const [addStockError, setAddStockError] = useState("");
  const [draggedStockId, setDraggedStockId] = useState<string | null>(null);
  const searchRequestId = useRef(0);
  const quoteRequestId = useRef(0);
  const trendRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const chartRequestId = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void loadAppState()
      .then((loadedState) => {
        if (active) {
          setState(loadedState);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(errorMessage(error, "本地数据读取失败"));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]?.newValue) return;
      const settings = normalizeState(changes[STORAGE_KEY].newValue).settings;
      setState((current) => current && JSON.stringify(current.settings) !== JSON.stringify(settings)
        ? { ...current, settings }
        : current);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  useEffect(() => {
    if (!state) {
      return;
    }
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.colorMode = state.settings.colorMode;
  }, [state]);

  const updateState = useCallback((updater: StateUpdater) => {
    setState((currentState) => {
      if (!currentState) {
        return currentState;
      }
      const nextState = updater(currentState);
      void saveAppState(nextState).catch((error: unknown) => {
        setStorageError(errorMessage(error, "本地数据保存失败"));
      });
      return nextState;
    });
  }, []);

  const selectedGroup = useMemo(() => {
    if (!state || state.selectedGroupId === ALL_GROUP_ID) {
      return null;
    }
    return state.groups.find((group) => group.id === state.selectedGroupId) ?? null;
  }, [state]);

  const visibleStockIds = useMemo(
    () => (state ? getStockIdsForGroup(state, state.selectedGroupId) : []),
    [state]
  );

  const visibleStocks = useMemo(
    () => (state ? visibleStockIds.map((stockId) => state.stocks[stockId]).filter(Boolean) : []),
    [state, visibleStockIds]
  );

  const refreshQuotes = useCallback(
    async (force: boolean) => {
      if (!state) {
        return;
      }

      const requestId = quoteRequestId.current + 1;
      quoteRequestId.current = requestId;
      const stocks = getStockIdsForGroup(state, state.selectedGroupId)
        .map((stockId) => state.stocks[stockId])
        .filter(Boolean);

      if (stocks.length === 0) {
        setQuoteLoading(false);
        setApiError("");
        return;
      }

      setQuoteLoading(true);
      try {
        const nextQuotes = await sendExtensionMessage<Quote[]>({
          type: "get_quotes",
          stocks,
          force
        });
        if (requestId !== quoteRequestId.current) {
          return;
        }
        const nextQuoteMap = Object.fromEntries(nextQuotes.map((quote) => [quote.secid, quote]));
        setQuotes((currentQuotes) => ({ ...currentQuotes, ...nextQuoteMap }));
        setApiError("");
      } catch (error: unknown) {
        if (requestId !== quoteRequestId.current) {
          return;
        }
        setQuotes((currentQuotes) => {
          const fallback = { ...currentQuotes };
          for (const stock of stocks) {
            fallback[stock.id] = {
              ...(fallback[stock.id] ?? emptyQuote(stock)),
              status: "stale"
            };
          }
          return fallback;
        });
        setApiError(errorMessage(error, "行情接口暂时不可用，已保留最近数据"));
      } finally {
        if (requestId === quoteRequestId.current) {
          setQuoteLoading(false);
        }
      }
    },
    [state]
  );

  useEffect(() => {
    if (!state || view === "detail") {
      return;
    }

    void refreshQuotes(false);
    const timer = window.setInterval(() => {
      void refreshQuotes(false);
    }, state.settings.refreshInterval * 1_000);
    return () => window.clearInterval(timer);
  }, [refreshQuotes, state, view]);

  useEffect(() => {
    if (!state || view === "detail" || visibleStocks.length === 0 || !state.settings.rowLayout.columns.some((column) => column.includes("trend"))) {
      return;
    }
    const requestId = ++trendRequestId.current;
    let busy = false;
    const refreshTrends = async () => {
      if (busy) return;
      busy = true;
      try {
        for (let index = 0; index < visibleStocks.length; index += 8) {
          const nextTrends = await sendExtensionMessage<IntradayTrend[]>({
            type: "get_trends",
            stocks: visibleStocks.slice(index, index + 8)
          });
          if (requestId !== trendRequestId.current) return;
          setTrends((current) => ({ ...current, ...Object.fromEntries(nextTrends.map((trend) => [trend.secid, trend])) }));
        }
      } catch {
        // A missing preview must not interrupt quote updates or the stock list.
      } finally {
        busy = false;
      }
    };
    void refreshTrends();
    const timer = window.setInterval(() => void refreshTrends(), 30_000);
    return () => {
      trendRequestId.current += 1;
      window.clearInterval(timer);
    };
  }, [state?.selectedGroupId, state?.settings.rowLayout.columns, view, visibleStocks]);

  const loadDetail = useCallback(async () => {
    if (!detailStock) {
      return;
    }

    const requestId = detailRequestId.current + 1;
    detailRequestId.current = requestId;
    setDetailLoading(true);
    setDetailError("");
    try {
      const detail = await sendExtensionMessage<Quote>({ type: "get_detail", stock: detailStock });
      if (requestId === detailRequestId.current) {
        setQuotes((currentQuotes) => ({ ...currentQuotes, [detail.secid]: detail }));
      }
    } catch (error: unknown) {
      if (requestId === detailRequestId.current) {
        setDetailError(errorMessage(error, "详情数据暂时不可用，列表数据仍可继续查看"));
      }
    } finally {
      if (requestId === detailRequestId.current) {
        setDetailLoading(false);
      }
    }
  }, [detailStock]);

  const loadChart = useCallback(async (force = false) => {
    if (!detailStock) {
      return;
    }

    const requestId = chartRequestId.current + 1;
    chartRequestId.current = requestId;
    const key = chartKey(detailStock.id, chartPeriod);
    setChartLoading(true);
    setChartError("");
    try {
      const nextChart = await sendExtensionMessage<KlineData>({
        type: "get_klines",
        stock: detailStock,
        period: chartPeriod,
        force
      });
      if (requestId === chartRequestId.current) {
        setChartData((currentCharts) => ({ ...currentCharts, [key]: nextChart }));
      }
    } catch (error: unknown) {
      if (requestId === chartRequestId.current) {
        setChartError(errorMessage(error, "走势图暂时不可用，请稍后重试"));
      }
    } finally {
      if (requestId === chartRequestId.current) {
        setChartLoading(false);
      }
    }
  }, [chartPeriod, detailStock]);

  const refreshDetail = useCallback(async () => {
    await Promise.all([loadDetail(), loadChart(true)]);
  }, [loadChart, loadDetail]);

  useEffect(() => {
    if (view === "detail" && detailStock) {
      void loadDetail();
    }
  }, [detailStock, loadDetail, view]);

  useEffect(() => {
    if (view === "detail" && detailStock) {
      void loadChart();
    }
  }, [chartPeriod, detailStock, loadChart, view]);

  useEffect(() => {
    const keyword = searchTerm.trim();
    searchRequestId.current += 1;
    const requestId = searchRequestId.current;
    setSearchError("");
    if (!keyword) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void sendExtensionMessage<Stock[]>({ type: "search_stocks", keyword })
        .then((results) => {
          if (requestId === searchRequestId.current) {
            setSearchResults(results);
          }
        })
        .catch((error: unknown) => {
          if (requestId === searchRequestId.current) {
            setSearchResults([]);
            setSearchError(errorMessage(error, "股票搜索失败"));
          }
        })
        .finally(() => {
          if (requestId === searchRequestId.current) {
            setSearchLoading(false);
          }
        });
    }, 320);

    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  const selectGroup = (groupId: string) => {
    updateState((currentState) => ({ ...currentState, selectedGroupId: groupId }));
    setView("list");
    setDetailStock(null);
  };

  const openAddStockDialog = (stock: Stock) => {
    if (!state) {
      return;
    }
    const memberships = getStockMemberships(state, stock.id).map((group) => group.id);
    const defaultGroupId =
      state.selectedGroupId !== ALL_GROUP_ID && state.groups.some((group) => group.id === state.selectedGroupId)
        ? state.selectedGroupId
        : (state.groups.find((group) => !group.hidden)?.id ?? state.groups[0]?.id);
    setAddStock(stock);
    setAddStockGroupIds(memberships.length > 0 ? memberships : defaultGroupId ? [defaultGroupId] : []);
    setAddStockError("");
  };

  const saveStockMembership = (groupIds: string[]) => {
    if (!addStock || groupIds.length === 0) {
      setAddStockError("请至少选择一个分组");
      return;
    }
    const selectedIds = new Set(groupIds);
    const stock = addStock;
    updateState((currentState) => ({
      ...currentState,
      stocks: { ...currentState.stocks, [stock.id]: stock },
      groups: currentState.groups.map((group) => ({
        ...group,
        stockIds: selectedIds.has(group.id)
          ? [...new Set([...group.stockIds, stock.id])]
          : group.stockIds.filter((stockId) => stockId !== stock.id)
      }))
    }));
    setAddStock(null);
    setSearchTerm("");
  };

  const removeStock = (stock: Stock) => {
    if (!state) {
      return;
    }
    const removeFromAll = state.selectedGroupId === ALL_GROUP_ID;

    updateState((currentState) => {
      const groups = currentState.groups.map((group) => {
        const shouldRemove = removeFromAll || group.id === currentState.selectedGroupId;
        return shouldRemove
          ? { ...group, stockIds: group.stockIds.filter((stockId) => stockId !== stock.id) }
          : group;
      });
      const stillInAnyGroup = groups.some((group) => group.stockIds.includes(stock.id));
      const stocks = { ...currentState.stocks };
      if (!stillInAnyGroup) {
        delete stocks[stock.id];
      }
      return { ...currentState, stocks, groups };
    });

    setQuotes((currentQuotes) => {
      const next = { ...currentQuotes };
      delete next[stock.id];
      return next;
    });
    if (detailStock?.id === stock.id) {
      setDetailStock(null);
      setView("list");
    }
  };

  const createGroup = (name: string) => {
    const trimmedName = name.trim();
    if (!state || !trimmedName) {
      return false;
    }
    if (state.groups.length >= 20) {
      setStorageError("分组数量已达到 20 个上限");
      return false;
    }
    const group: StockGroup = {
      id: createId("group"),
      name: trimmedName,
      stockIds: [],
      order: state.groups.length,
      hidden: false
    };
    updateState((currentState) => ({
      ...currentState,
      groups: [...currentState.groups, { ...group, order: currentState.groups.length }],
      selectedGroupId: group.id
    }));
    setShowAddGroup(false);
    return true;
  };

  const renameGroup = (groupId: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return false;
    }
    updateState((currentState) => ({
      ...currentState,
      groups: currentState.groups.map((group) => (group.id === groupId ? { ...group, name: trimmedName } : group))
    }));
    return true;
  };

  const deleteGroup = (groupId: string) => {
    if (!state) {
      return;
    }
    if (state.groups.length <= 1) {
      setStorageError("至少保留一个股票分组");
      return;
    }
    const group = state.groups.find((item) => item.id === groupId);
    if (!group || !window.confirm(`删除“${group.name}”分组？\n\n只删除分组关系，不会删除股票。`)) {
      return;
    }
    updateState((currentState) => {
      const groups = currentState.groups
        .filter((item) => item.id !== groupId)
        .map((item, index) => ({ ...item, order: index }));
      const selectedGroupId = currentState.selectedGroupId === groupId
        ? currentState.allGroupHidden
          ? groups.find((item) => !item.hidden)?.id ?? ALL_GROUP_ID
          : ALL_GROUP_ID
        : currentState.selectedGroupId;
      return { ...currentState, groups, selectedGroupId };
    });
  };

  const toggleAllGroupVisibility = () => {
    if (!state) {
      return;
    }
    const isHiding = !state.allGroupHidden;
    if (isHiding && !state.groups.some((group) => !group.hidden)) {
      setStorageError("至少保留一个可见分组");
      return;
    }
    setStorageError("");
    updateState((currentState) => {
      const selectedGroupId = currentState.selectedGroupId === ALL_GROUP_ID && isHiding
        ? currentState.groups.find((group) => !group.hidden)?.id ?? ALL_GROUP_ID
        : currentState.selectedGroupId;
      return {
        ...currentState,
        allGroupHidden: !currentState.allGroupHidden,
        selectedGroupId
      };
    });
  };

  const toggleGroupVisibility = (groupId: string) => {
    if (!state) {
      return;
    }
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) {
      return;
    }
    const isHiding = !group.hidden;
    if (isHiding) {
      const visibleCount = state.groups.filter((item) => !item.hidden).length;
      if (visibleCount <= 1) {
        setStorageError("至少保留一个可见分组");
        return;
      }
    }
    setStorageError("");
    updateState((currentState) => {
      const groups = currentState.groups.map((item) =>
        item.id === groupId ? { ...item, hidden: !item.hidden } : item
      );
      const selectedGroupId =
        currentState.selectedGroupId === groupId && isHiding
          ? currentState.allGroupHidden
            ? currentState.groups.find((item) => item.id !== groupId && !item.hidden)?.id ?? ALL_GROUP_ID
            : ALL_GROUP_ID
          : currentState.selectedGroupId;
      return { ...currentState, groups, selectedGroupId };
    });
  };

  const moveGroup = (fromGroupId: string, toGroupId: string) => {
    if (fromGroupId === toGroupId) {
      return;
    }
    updateState((currentState) => {
      const groups = [...currentState.groups];
      const fromIndex = groups.findIndex((group) => group.id === fromGroupId);
      const toIndex = groups.findIndex((group) => group.id === toGroupId);
      if (fromIndex < 0 || toIndex < 0) {
        return currentState;
      }
      const [moved] = groups.splice(fromIndex, 1);
      groups.splice(toIndex, 0, moved);
      return { ...currentState, groups: groups.map((group, index) => ({ ...group, order: index })) };
    });
  };

  const moveStock = (fromStockId: string, toStockId: string) => {
    if (!state || state.selectedGroupId === ALL_GROUP_ID || fromStockId === toStockId) {
      return;
    }
    updateState((currentState) => ({
      ...currentState,
      groups: currentState.groups.map((group) => {
        if (group.id !== currentState.selectedGroupId) {
          return group;
        }
        const stockIds = [...group.stockIds];
        const fromIndex = stockIds.indexOf(fromStockId);
        const toIndex = stockIds.indexOf(toStockId);
        if (fromIndex < 0 || toIndex < 0) {
          return group;
        }
        stockIds.splice(fromIndex, 1);
        stockIds.splice(toIndex, 0, fromStockId);
        return { ...group, stockIds };
      })
    }));
  };

  const openDetail = (stock: Stock) => {
    setDetailStock(stock);
    setChartPeriod("intraday");
    setChartError("");
    setView("detail");
  };

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
  };

  const focusSearch = () => {
    searchInputRef.current?.focus();
  };

  if (loadError) {
    return <main className="page-shell centered-state"><EmptyState title="数据加载失败" description={loadError} actionLabel="重新加载" onAction={() => window.location.reload()} /></main>;
  }

  if (!state) {
    return <main className="page-shell centered-state"><div className="loading-spinner" /><span>正在读取自选数据…</span></main>;
  }

  if (view === "detail" && detailStock) {
    return (
      <>
        <DetailView
          stock={detailStock}
          quote={quotes[detailStock.id] ?? emptyQuote(detailStock)}
          loading={detailLoading || chartLoading}
          error={detailError}
          chart={chartData[chartKey(detailStock.id, chartPeriod)]}
          chartPeriod={chartPeriod}
          chartLoading={chartLoading}
          chartError={chartError}
          colorMode={state.settings.colorMode}
          onBack={() => {
            setView("list");
            setDetailStock(null);
          }}
          onRefresh={refreshDetail}
          onPeriodChange={(period) => {
            setChartPeriod(period);
            setChartError("");
          }}
          onOpenExternal={() => void chrome.tabs.create({ url: getEastmoneyUrl(detailStock) })}
          onManageGroups={() => openAddStockDialog(detailStock)}
          onRemove={() => removeStock(detailStock)}
        />
        {addStock && (
          <StockGroupDialog
            stock={addStock}
            groups={state.groups}
            selectedGroupIds={addStockGroupIds}
            error={addStockError}
            onClose={() => setAddStock(null)}
            onToggle={(groupId) => {
              setAddStockGroupIds((currentIds) => currentIds.includes(groupId) ? currentIds.filter((id) => id !== groupId) : [...currentIds, groupId]);
              setAddStockError("");
            }}
            onSave={() => saveStockMembership(addStockGroupIds)}
          />
        )}
      </>
    );
  }

  const currentGroupLabel = selectedGroup?.name ?? "全部自选";
  const canDragStocks = state.selectedGroupId !== ALL_GROUP_ID;
  const allStockCount = getStockIdsForGroup(state, ALL_GROUP_ID).length;

  return (
    <main className="page-shell popup-shell list-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">↗</span>
          <div>
            <p className="eyebrow">自选 · 市场脉搏</p>
            <h1>股票行情</h1>
          </div>
        </div>
        <div className="header-actions">
          <button className={`icon-button ${quoteLoading ? "is-loading" : ""}`} type="button" title="刷新行情" onClick={() => void refreshQuotes(true)} disabled={quoteLoading}>
            ↻
          </button>
          <button className="icon-button" type="button" title="打开设置" onClick={openOptions}>⚙</button>
        </div>
      </header>

      <div className="search-wrap">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          ref={searchInputRef}
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="搜索股票、ETF、港股或韩国股票"
          aria-label="搜索股票、ETF、港股或韩国股票"
        />
        {searchTerm && <button className="clear-search" type="button" onClick={() => setSearchTerm("")} aria-label="清空搜索">×</button>}
      </div>

      {searchTerm.trim() && (
        <SearchResults
          keyword={searchTerm.trim()}
          results={searchResults}
          loading={searchLoading}
          error={searchError}
          isAdded={(stockId) => Boolean(state.stocks[stockId])}
          onSelect={openAddStockDialog}
        />
      )}

      <section className="group-section" aria-label="股票分组">
        <div className="group-tabs" role="tablist">
          {!state.allGroupHidden && (
            <button className={`group-tab ${state.selectedGroupId === ALL_GROUP_ID ? "active" : ""}`} type="button" role="tab" aria-selected={state.selectedGroupId === ALL_GROUP_ID} onClick={() => selectGroup(ALL_GROUP_ID)}>
              <span>全部自选</span><span className="tab-count">{allStockCount}</span>
            </button>
          )}
          {state.groups
            .filter((group) => !group.hidden)
            .map((group) => (
              <button className={`group-tab ${state.selectedGroupId === group.id ? "active" : ""}`} type="button" role="tab" aria-selected={state.selectedGroupId === group.id} key={group.id} onClick={() => selectGroup(group.id)}>
                <span>{group.name}</span><span className="tab-count">{group.stockIds.length}</span>
              </button>
            ))}
          <button className="add-group-button" type="button" title="创建分组" onClick={() => setShowAddGroup(true)}>＋</button>
        </div>
        <button className="text-button manage-groups" type="button" onClick={() => setShowGroupManager(true)}>管理</button>
      </section>

      {apiError && (
        <div className="notice notice-warning">
          <span>{apiError}</span>
          <button className="text-button" type="button" onClick={() => void refreshQuotes(true)}>重试</button>
        </div>
      )}
      {storageError && (
        <div className="notice notice-error">
          <span>{storageError}</span>
          <button className="notice-close" type="button" onClick={() => setStorageError("")} aria-label="关闭提示">×</button>
        </div>
      )}

      {visibleStocks.length === 0 ? (
        <EmptyState title={state.selectedGroupId === ALL_GROUP_ID ? "还没有自选股票" : "这个分组还没有股票"} description="搜索股票代码或名称，把关注的股票加入分组。" actionLabel="添加股票" onAction={focusSearch} />
      ) : (
        <section className="stock-list" aria-label={`${currentGroupLabel}行情列表`}>
          {visibleStocks.map((stock) => (
            <StockRow
              key={stock.id}
              stock={stock}
              quote={quotes[stock.id] ?? emptyQuote(stock)}
              trend={trends[stock.id]}
              layout={state.settings.rowLayout}
              draggable={canDragStocks}
              onOpen={() => openDetail(stock)}
              onManageGroups={() => openAddStockDialog(stock)}
              onRemove={() => removeStock(stock)}
              onDragStart={() => setDraggedStockId(stock.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedStockId) {
                  moveStock(draggedStockId, stock.id);
                }
                setDraggedStockId(null);
              }}
              onDragEnd={() => setDraggedStockId(null)}
            />
          ))}
        </section>
      )}

      {canDragStocks && visibleStocks.length > 1 && <p className="drag-hint">拖动股票可调整当前分组顺序</p>}
      {!canDragStocks && visibleStocks.length > 1 && <p className="drag-hint">全部自选按分组顺序汇总显示</p>}

      <footer className="app-footer">
        <span>自动刷新 {state.settings.refreshInterval}s</span>
        <button className="text-button" type="button" onClick={focusSearch}>＋ 添加股票</button>
      </footer>

      {showAddGroup && <AddGroupDialog onClose={() => setShowAddGroup(false)} onSubmit={createGroup} />}
      {showGroupManager && (
        <GroupManagerDialog
          groups={state.groups}
          allGroupHidden={state.allGroupHidden}
          onClose={() => setShowGroupManager(false)}
          onRename={renameGroup}
          onDelete={deleteGroup}
          onToggleAllVisibility={toggleAllGroupVisibility}
          onToggleVisibility={toggleGroupVisibility}
          onMove={moveGroup}
          onAdd={() => {
            setShowGroupManager(false);
            setShowAddGroup(true);
          }}
        />
      )}
      {addStock && (
        <StockGroupDialog
          stock={addStock}
          groups={state.groups}
          selectedGroupIds={addStockGroupIds}
          error={addStockError}
          onClose={() => setAddStock(null)}
          onToggle={(groupId) => {
            setAddStockGroupIds((currentIds) => currentIds.includes(groupId) ? currentIds.filter((id) => id !== groupId) : [...currentIds, groupId]);
            setAddStockError("");
          }}
          onSave={() => saveStockMembership(addStockGroupIds)}
        />
      )}
    </main>
  );
}

function SearchResults({
  keyword,
  results,
  loading,
  error,
  isAdded,
  onSelect
}: {
  keyword: string;
  results: Stock[];
  loading: boolean;
  error: string;
  isAdded: (stockId: string) => boolean;
  onSelect: (stock: Stock) => void;
}) {
  return (
    <section className="search-results" aria-label="股票搜索结果">
      <div className="search-results-header"><span>搜索“{keyword}”</span>{loading && <span className="inline-loading">查询中…</span>}</div>
      {error && <p className="search-empty">{error}</p>}
      {!loading && !error && results.length === 0 && <p className="search-empty">没有找到支持的证券</p>}
      {results.map((stock) => (
        <button className="search-result" type="button" key={stock.id} onClick={() => onSelect(stock)}>
          <span className="search-result-main"><strong>{stock.name}</strong><small>{stock.code} · {stockMarketLabel(stock)}</small></span>
          <span className={`search-result-state ${isAdded(stock.id) ? "added" : ""}`}>{isAdded(stock.id) ? "已添加" : "加入"}</span>
        </button>
      ))}
    </section>
  );
}

function StockRow({
  stock,
  quote,
  trend,
  layout,
  draggable,
  onOpen,
  onManageGroups,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  stock: Stock;
  quote: Quote;
  trend?: IntradayTrend;
  layout: RowLayout;
  draggable: boolean;
  onOpen: () => void;
  onManageGroups: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const tone = getTone(quote.changePercent);
  const statusLabel = quoteStatusLabel(quote.status);
  const showStatusTag = quote.status === "stale";

  const amountStr = formatCompactAmount(quote.amount);
  const turnoverStr =
    quote.turnoverRate !== null && quote.turnoverRate !== undefined && Number.isFinite(quote.turnoverRate)
      ? `${quote.turnoverRate.toFixed(2)}%`
      : "--";
  const highStr = formatPrice(quote.high);
  const lowStr = formatPrice(quote.low);
  const columns = layout.columns.filter((column) => column.length > 0);
  const fieldValues: Record<RowField, string> = {
    name: stock.name,
    code: `${stock.code} · ${stockMarketLabel(stock)}`,
    trend: "",
    changePercent: formatPercent(quote.changePercent),
    price: formatPrice(quote.price),
    change: formatSignedNumber(quote.change),
    amount: `额 ${amountStr}`,
    turnover: `换 ${turnoverStr}`,
    high: `高 ${highStr}`,
    low: `低 ${lowStr}`,
    open: `开 ${formatPrice(quote.open)}`,
    prevClose: `昨 ${formatPrice(quote.prevClose)}`,
    volume: `量 ${formatVolume(quote.volume)}`,
    marketCap: `市值 ${formatCompactAmount(quote.marketCap)}`,
    floatMarketCap: `流值 ${formatCompactAmount(quote.floatMarketCap)}`,
    pe: `PE ${formatPrice(quote.pe)}`,
    pb: `PB ${formatPrice(quote.pb)}`
  };
  const columnWidth = (column: RowField[]) => {
    if (column.length === 1 && column[0] === "trend") return "96px";
    if (column.includes("name")) return "minmax(76px, 1fr)";
    if (column.some((field) => field === "changePercent" || field === "price")) return "minmax(80px, 0.9fr)";
    return "minmax(62px, 0.8fr)";
  };

  const tooltip = `${stock.name} (${stock.code} · ${stockMarketLabel(stock)})\n最新价: ${formatPrice(quote.price)} (${formatPercent(quote.changePercent)})\n成交额: ${amountStr} | 换手率: ${turnoverStr}\n最高: ${highStr} | 最低: ${lowStr}\n今开: ${formatPrice(quote.open)} | 昨收: ${formatPrice(quote.prevClose)}\n总市值: ${formatCompactAmount(quote.marketCap)} | 流通市值: ${formatCompactAmount(quote.floatMarketCap)}`;

  return (
    <div
      className={`stock-row ${tone}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={tooltip}
    >
      <button className="stock-row-main" type="button" onClick={onOpen}
        style={{ gridTemplateColumns: columns.map(columnWidth).join(" ") }}>
        {columns.map((column, columnIndex) => (
          <span className="stock-layout-column" key={columnIndex}>
            {column.map((field, fieldIndex) => field === "trend"
              ? <MiniTrend key={field} stock={stock} trend={trend} tone={tone} />
              : <span key={field} className={`stock-layout-field field-${field} ${fieldIndex === 0 ? "first-field" : ""}`}>
                  {field === "name" ? <span className="stock-name-line"><strong className="stock-name">{stock.name}</strong>{showStatusTag && <span className={`status-badge ${quote.status}`}>{statusLabel}</span>}</span>
                    : fieldValues[field]}
                </span>)}
          </span>
        ))}
      </button>

      <div className="row-actions">
        <button
          className="row-action"
          type="button"
          title="管理分组"
          onClick={(event) => {
            event.stopPropagation();
            onManageGroups();
          }}
        >
          分组
        </button>
        <button
          className="row-action danger"
          type="button"
          title="从当前分组移除"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          移除
        </button>
      </div>
    </div>
  );
}

function MiniTrend({ stock, trend, tone }: { stock: Stock; trend?: IntradayTrend; tone: string }) {
  const prices = trend?.prices ?? [];
  const prevClose = trend?.prevClose;
  const reference = prevClose && prevClose > 0 ? prevClose : prices[0];
  if (!reference || prices.length === 0) {
    return <span className="mini-trend empty" aria-label={`${stock.name}暂无分时数据`} />;
  }

  const maxDeviation = Math.max(reference * 0.005, ...prices.map((price) => Math.abs(price - reference)));
  const points = prices.map((price, index) => {
    const x = (index / Math.max(240, prices.length - 1)) * 96;
    const y = 17 - ((price - reference) / maxDeviation) * 14;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M ${points.join(" L ")}`;
  const area = `${line} L ${((prices.length - 1) / Math.max(240, prices.length - 1) * 96).toFixed(2)},34 L 0,34 Z`;
  const gradientId = `mini-trend-${stock.id.replace(/[^a-zA-Z0-9-]/g, "-")}`;

  return (
    <span className={`mini-trend ${tone}`} role="img" aria-label={`${stock.name}当日分时缩略图`}>
      <svg viewBox="0 0 96 34" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="mini-trend-baseline" d="M 0,17 H 96" />
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">◎</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="primary-button" type="button" onClick={onAction}>{actionLabel}</button>
    </div>
  );
}

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-header"><h2>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </section>
    </div>
  );
}

function AddGroupDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string) => boolean }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请输入分组名称");
      return;
    }
    if (!onSubmit(name)) {
      setError("分组创建失败");
    }
  };
  return (
    <Dialog title="创建分组" onClose={onClose} footer={<><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" form="add-group-form">创建</button></>}>
      <form id="add-group-form" onSubmit={submit}>
        <label className="field-label" htmlFor="new-group-name">分组名称</label>
        <input id="new-group-name" className="text-input" autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="例如：短线观察" maxLength={20} />
        {error && <p className="form-error">{error}</p>}
      </form>
    </Dialog>
  );
}

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.3" />
      <circle cx="8" cy="2" r="1.3" />
      <circle cx="2" cy="7" r="1.3" />
      <circle cx="8" cy="7" r="1.3" />
      <circle cx="2" cy="12" r="1.3" />
      <circle cx="8" cy="12" r="1.3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function GroupManagerDialog({
  groups,
  allGroupHidden,
  onClose,
  onRename,
  onDelete,
  onToggleAllVisibility,
  onToggleVisibility,
  onMove,
  onAdd
}: {
  groups: StockGroup[];
  allGroupHidden: boolean;
  onClose: () => void;
  onRename: (groupId: string, name: string) => boolean;
  onDelete: (groupId: string) => void;
  onToggleAllVisibility: () => void;
  onToggleVisibility: (groupId: string) => void;
  onMove: (fromGroupId: string, toGroupId: string) => void;
  onAdd: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((group) => [group.id, group.name])));
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  return (
    <Dialog title="管理分组" onClose={onClose} footer={<><button className="secondary-button" type="button" onClick={onClose}>完成</button><button className="primary-button" type="button" onClick={onAdd}>＋ 新建分组</button></>}>
      <style>{`
        .managed-group-icon-btn {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: var(--text-muted, #64748b);
          cursor: pointer;
          transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
          padding: 0;
          flex-shrink: 0;
        }
        .managed-group-icon-btn:hover {
          background: color-mix(in srgb, var(--surface-muted, #f1f5f9) 90%, var(--text, #000) 10%);
          color: var(--text, #1e293b);
        }
        .managed-group-icon-btn.is-active-save {
          color: #10b981;
        }
        .managed-group-icon-btn.is-active-save:hover {
          background: rgba(16, 185, 129, 0.12);
          color: #059669;
        }
        .managed-group-icon-btn.is-danger {
          color: var(--text-muted, #94a3b8);
        }
        .managed-group-icon-btn.is-danger:hover {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
        }
        .managed-group-icon-btn.is-hidden-eye {
          opacity: 0.45;
        }
        .managed-group-icon-btn.is-hidden-eye:hover {
          opacity: 0.9;
          color: var(--accent, #2563eb);
        }
        .managed-group-actions {
          display: flex;
          align-items: center;
          gap: 2px;
          flex-shrink: 0;
        }
      `}</style>
      <p className="dialog-help">点击眼睛图标可控制分组是否在主界面展示。“全部自选”会自动汇总可见分组，删除自定义分组只删除关系，不删除股票。</p>
      <div className="managed-groups">
        <div className={`managed-group managed-system-group ${allGroupHidden ? "is-hidden" : ""}`}>
          <span className="drag-handle" aria-hidden="true">·</span>
          <button
            className={`managed-group-icon-btn ${allGroupHidden ? "is-hidden-eye" : ""}`}
            type="button"
            title={allGroupHidden ? "已隐藏，点击在主界面展示" : "展示中，点击隐藏该分组"}
            aria-label={allGroupHidden ? "展示全部自选" : "隐藏全部自选"}
            onClick={onToggleAllVisibility}
          >
            {allGroupHidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <div className="managed-group-fields">
            <strong>全部自选</strong>
            <small>自动汇总可见分组</small>
          </div>
        </div>
        {groups.map((group) => {
          const isHidden = Boolean(group.hidden);
          const isModified = drafts[group.id] !== undefined && drafts[group.id].trim() !== group.name;
          const handleSave = () => {
            const currentVal = drafts[group.id] ?? group.name;
            if (!onRename(group.id, currentVal)) {
              setDrafts((current) => ({ ...current, [group.id]: group.name }));
            }
          };

          return (
            <div
              className={`managed-group ${isHidden ? "is-hidden" : ""}`}
              key={group.id}
              draggable
              onDragStart={() => setDraggedGroupId(group.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); if (draggedGroupId) onMove(draggedGroupId, group.id); setDraggedGroupId(null); }}
              onDragEnd={() => setDraggedGroupId(null)}
              style={isHidden ? { opacity: 0.6 } : undefined}
            >
              <span className="drag-handle" title="拖动排序" style={{ display: "inline-flex", alignItems: "center", cursor: "grab", opacity: 0.6 }}>
                <GripIcon />
              </span>
              <button
                className={`managed-group-icon-btn ${isHidden ? "is-hidden-eye" : ""}`}
                type="button"
                title={isHidden ? "已隐藏，点击在主界面展示" : "展示中，点击隐藏该分组"}
                aria-label={isHidden ? `展示${group.name}` : `隐藏${group.name}`}
                onClick={() => onToggleVisibility(group.id)}
              >
                {isHidden ? <EyeOffIcon /> : <EyeIcon />}
              </button>
              <div className="managed-group-fields">
                <input
                  className="text-input"
                  value={drafts[group.id] ?? group.name}
                  maxLength={20}
                  onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSave();
                    }
                  }}
                />
              </div>
              <div className="managed-group-actions">
                <button
                  className={`managed-group-icon-btn ${isModified ? "is-active-save" : ""}`}
                  type="button"
                  title={isModified ? "保存修改" : "保存"}
                  aria-label="保存"
                  onClick={handleSave}
                >
                  <CheckIcon />
                </button>
                <button
                  className="managed-group-icon-btn is-danger"
                  type="button"
                  title="删除分组"
                  aria-label="删除分组"
                  onClick={() => onDelete(group.id)}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

function StockGroupDialog({
  stock,
  groups,
  selectedGroupIds,
  error,
  onClose,
  onToggle,
  onSave
}: {
  stock: Stock;
  groups: StockGroup[];
  selectedGroupIds: string[];
  error: string;
  onClose: () => void;
  onToggle: (groupId: string) => void;
  onSave: () => void;
}) {
  return (
    <Dialog title="选择分组" onClose={onClose} footer={<><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={onSave}>保存</button></>}>
      <div className="selected-stock-summary"><strong>{stock.name}</strong><span>{stock.code} · {stockMarketLabel(stock)}</span></div>
      <p className="dialog-help">同一只股票可以加入多个分组。</p>
      <div className="group-checkboxes">
        {groups.map((group) => (
          <label className="checkbox-row" key={group.id} style={group.hidden ? { opacity: 0.75 } : undefined}>
            <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => onToggle(group.id)} />
            <span>
              {group.name}
              {group.hidden && <span style={{ fontSize: "11px", color: "var(--text-muted, #9ca3af)", marginLeft: "4px" }}>(已隐藏)</span>}
            </span>
            <small>{group.stockIds.length} 只</small>
          </label>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

function DetailView({
  stock,
  quote,
  loading,
  error,
  chart,
  chartPeriod,
  chartLoading,
  chartError,
  colorMode,
  onBack,
  onRefresh,
  onPeriodChange,
  onOpenExternal,
  onManageGroups,
  onRemove
}: {
  stock: Stock;
  quote: Quote;
  loading: boolean;
  error: string;
  chart?: KlineData;
  chartPeriod: KlinePeriod;
  chartLoading: boolean;
  chartError: string;
  colorMode: AppState["settings"]["colorMode"];
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onPeriodChange: (period: KlinePeriod) => void;
  onOpenExternal: () => void;
  onManageGroups: () => void;
  onRemove: () => void;
}) {
  const [hoverPoint, setHoverPoint] = useState<KlinePoint | null>(null);
  const tone = getTone(quote.changePercent);
  const selectedPeriod = chartPeriods.find((period) => period.value === chartPeriod) ?? chartPeriods[0];
  const latestPoint = chart?.points.at(-1);
  const latestChartPrice = latestPoint?.close ?? null;
  const chartReference = chart?.prevClose ?? null;
  const summaryPoint = hoverPoint ?? latestPoint;
  const summaryPrice = summaryPoint?.close ?? latestChartPrice ?? quote.price;
  const summaryChange = summaryPrice !== null && chartReference !== null && chartReference !== 0
    ? summaryPrice - chartReference
    : null;
  const summaryChangePercent = summaryPrice !== null && chartReference !== null && chartReference !== 0 && summaryChange !== null
    ? (summaryChange / chartReference) * 100
    : null;
  useEffect(() => {
    setHoverPoint(null);
  }, [chart?.secid, chart?.updatedAt, chartPeriod]);
  return (
    <main className="page-shell popup-shell detail-shell">
      <header className="app-header detail-header">
        <button className="back-button" type="button" onClick={onBack}>← 返回列表</button>
        <div className="header-actions"><button className={`icon-button ${loading ? "is-loading" : ""}`} type="button" title="刷新详情" onClick={() => void onRefresh()} disabled={loading}>↻</button></div>
      </header>
      <section className="detail-hero">
        <div className="detail-identity"><p className="eyebrow">{stockMarketLabel(stock)} · {stock.code}</p><h1>{stock.name}</h1></div>
        <div className={`detail-price ${tone}`}><strong>{formatPrice(quote.price)}</strong><span>{formatSignedNumber(quote.change)}　{formatPercent(quote.changePercent)}</span></div>
      </section>
      {error && <div className="notice notice-warning"><span>{error}</span><button className="text-button" type="button" onClick={() => void onRefresh()}>重试</button></div>}

      <section className="detail-chart-card" aria-label={`${stock.name}${selectedPeriod.label}走势图`}>
        <div className="chart-card-heading">
          <div className={`chart-hover-summary ${summaryPoint ? getTone(summaryChangePercent) : "is-empty"}`} aria-live="polite">
            {summaryPoint ? (
              <>
              <div className="chart-hover-summary-heading">
                <span>{hoverPoint ? formatChartTooltipTime(summaryPoint.timestamp, chartPeriod) : `最新 · ${formatChartTooltipTime(summaryPoint.timestamp, chartPeriod)}`}</span>
                <strong>{formatPrice(summaryPrice)}</strong>
              </div>
              <div className="chart-hover-summary-grid">
                {chartPeriod === "intraday" ? (
                  <>
                    <span>价格 <b>{formatPrice(summaryPrice)}</b></span>
                    <span>昨收 <b>{formatPrice(chartReference)}</b></span>
                  </>
                ) : (
                  <>
                    <span>开 <b>{formatPrice(summaryPoint.open ?? summaryPrice)}</b></span>
                    <span>高 <b>{formatPrice(summaryPoint.high ?? summaryPrice)}</b></span>
                    <span>低 <b>{formatPrice(summaryPoint.low ?? summaryPrice)}</b></span>
                    <span>收 <b>{formatPrice(summaryPrice)}</b></span>
                  </>
                )}
                <span className="chart-hover-summary-change">涨跌 <b>{formatSignedNumber(summaryChange)}</b></span>
                <span className="chart-hover-summary-change">幅度 <b>{formatPercent(summaryChangePercent)}</b></span>
                <span>成交量 <b>{formatVolume(summaryPoint.volume)}</b></span>
                <span>成交额 <b>{formatCompactAmount(summaryPoint.amount)}</b></span>
              </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="chart-period-tabs" role="tablist" aria-label="走势图周期">
          {chartPeriods.map((period) => (
            <button
              className={`chart-period-tab ${chartPeriod === period.value ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={chartPeriod === period.value}
              key={period.value}
              onClick={() => onPeriodChange(period.value)}
            >
              {period.label}
            </button>
          ))}
        </div>

        <div className={`chart-stage ${chartLoading ? "is-loading" : ""}`}>
          {chart && chart.points.length > 0 ? (
            <KlineChart data={chart} period={chartPeriod} onHoverPointChange={setHoverPoint} />
          ) : chartLoading ? (
            <div className="chart-placeholder"><span className="loading-spinner" /><span>正在加载{selectedPeriod.label}数据…</span></div>
          ) : (
            <div className="chart-placeholder"><span className="chart-placeholder-icon">⌁</span><span>暂无{selectedPeriod.label}数据</span></div>
          )}
          {chartLoading && chart && chart.points.length > 0 && <span className="chart-loading-badge">更新中…</span>}
        </div>
        {chartError && <div className="chart-error"><span>{chartError}</span><button className="text-button" type="button" onClick={() => void onRefresh()}>重试</button></div>}
        <div className="chart-card-footer">
          <span>{chart ? `已加载 ${chart.points.length} 个${chartPeriod === "intraday" ? "分时点" : chartPeriod === "daily" ? "交易日" : "交易周"}` : "切换周期查看历史走势"}</span>
          <span>数据仅供参考</span>
        </div>
      </section>

      <section className="detail-actions">
        <button className="secondary-button" type="button" onClick={onManageGroups}>加入其他分组</button>
        <button className="secondary-button" type="button" onClick={onOpenExternal}>东方财富网页</button>
        <button className="secondary-button danger-outline" type="button" onClick={onRemove}>从当前分组移除</button>
      </section>
      <p className="detail-footnote">{colorMode === "china" ? "红涨绿跌" : "绿涨红跌"} · 分时、日 K、周 K 支持按周期切换</p>
    </main>
  );
}

function KlineChart({ data, period, onHoverPointChange }: {
  data: KlineData;
  period: KlinePeriod;
  onHoverPointChange?: (point: KlinePoint | null) => void;
}) {
  const [hoverPosition, setHoverPosition] = useState<{ index: number; y: number } | null>(null);
  const width = 420;
  const height = 260;
  const plotLeft = 48;
  const plotRight = 12;
  const plotTop = 14;
  const timeAxisHeight = 24;
  const volumeHeight = 42;
  const volumeGap = 10;
  const volumeTop = height - timeAxisHeight - volumeHeight;
  const pricePlotBottom = volumeTop - volumeGap;
  const plotWidth = width - plotLeft - plotRight;
  const plotHeight = pricePlotBottom - plotTop;
  const drawablePoints = data.points.filter((point) => point.close !== null).slice(period === "intraday" ? 0 : -90);

  useEffect(() => {
    setHoverPosition(null);
    onHoverPointChange?.(null);
  }, [data.secid, onHoverPointChange, period]);

  if (drawablePoints.length === 0) {
    return <div className="chart-placeholder"><span className="chart-placeholder-icon">⌁</span><span>暂无可绘制数据</span></div>;
  }

  const reference = data.prevClose ?? drawablePoints[0].close ?? 0;
  const values = drawablePoints.flatMap((point) => {
    if (period === "intraday") {
      return [point.close ?? 0];
    }
    return [point.low ?? point.close ?? 0, point.high ?? point.close ?? 0, point.open ?? point.close ?? 0, point.close ?? 0];
  }).concat(reference > 0 ? [reference] : []);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.max(Math.abs(rawMax), 1) * 0.003);
  const minValue = rawMin - padding;
  const maxValue = rawMax + padding;
  const valueRange = Math.max(maxValue - minValue, 0.0001);
  const yFor = (value: number) => plotTop + ((maxValue - value) / valueRange) * plotHeight;
  const xForLine = (index: number) => plotLeft + (index / Math.max(1, drawablePoints.length - 1)) * plotWidth;
  const xForPoint = (index: number) => plotLeft + ((index + 0.5) / drawablePoints.length) * plotWidth;
  const xForData = (index: number) => period === "intraday" ? xForLine(index) : xForPoint(index);
  const linePoints = drawablePoints.map((point, index) => `${xForLine(index).toFixed(2)},${yFor(point.close ?? reference).toFixed(2)}`);
  const linePath = `M ${linePoints.join(" L ")}`;
  const lastX = xForLine(drawablePoints.length - 1);
  const areaPath = `${linePath} L ${lastX.toFixed(2)},${pricePlotBottom.toFixed(2)} L ${plotLeft},${pricePlotBottom.toFixed(2)} Z`;
  const chartTone = getTone((drawablePoints.at(-1)?.close ?? reference) - reference);
  const gradientId = `detail-chart-${data.secid.replace(/[^a-zA-Z0-9-]/g, "-")}-${period}`;
  const gridValues = [maxValue, minValue + valueRange / 2, minValue];
  const candleWidth = Math.max(2, Math.min(8, (plotWidth / drawablePoints.length) * 0.58));
  const volumeMax = Math.max(...drawablePoints.map((point) => point.volume ?? 0), 0);
  const volumeRange = Math.max(volumeMax, 1);
  const volumeBottom = volumeTop + volumeHeight;
  const volumeFor = (volume: number) => volumeBottom - (Math.min(Math.max(volume, 0), volumeRange) / volumeRange) * volumeHeight;
  const volumeBarWidth = Math.max(1.5, Math.min(8, (plotWidth / drawablePoints.length) * 0.66));
  const dateIndexes = drawablePoints.length === 1 ? [0] : [0, Math.floor((drawablePoints.length - 1) / 2), drawablePoints.length - 1];
  const safeHoverIndex = hoverPosition === null ? null : Math.min(Math.max(hoverPosition.index, 0), drawablePoints.length - 1);
  const hoverPoint = safeHoverIndex === null ? null : drawablePoints[safeHoverIndex];
  const hoverX = safeHoverIndex === null ? null : xForData(safeHoverIndex);
  const hoverY = hoverPosition?.y ?? null;
  const hoverTone = hoverPoint ? getTone((hoverPoint.close ?? reference) - reference) : chartTone;
  const crosshairPrice = hoverY === null
    ? null
    : maxValue - ((hoverY - plotTop) / plotHeight) * valueRange;
  const crosshairPriceLabelHeight = 16;
  const crosshairPriceLabelY = hoverY === null
    ? 0
    : Math.min(Math.max(hoverY - crosshairPriceLabelHeight / 2, plotTop), pricePlotBottom - crosshairPriceLabelHeight);
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const viewBoxX = ((event.clientX - bounds.left) / bounds.width) * width;
    const viewBoxY = ((event.clientY - bounds.top) / bounds.height) * height;
    const clampedX = Math.min(Math.max(viewBoxX, plotLeft), plotLeft + plotWidth);
    const clampedY = Math.min(Math.max(viewBoxY, plotTop), pricePlotBottom);
    const ratio = (clampedX - plotLeft) / plotWidth;
    const nextIndex = Math.round(ratio * (drawablePoints.length - 1));
    setHoverPosition({ index: nextIndex, y: clampedY });
    onHoverPointChange?.(drawablePoints[nextIndex]);
  };
  const pointTone = (point: KlinePoint, index: number) => {
    const close = point.close ?? 0;
    const comparison = period === "intraday"
      ? drawablePoints[index - 1]?.close ?? reference
      : point.open ?? close;
    return getTone(close - (comparison ?? close));
  };

  return (
    <svg
      className={`kline-chart ${period} ${chartTone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${period === "intraday" ? "分时" : period === "daily" ? "日 K" : "周 K"}走势图`}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        setHoverPosition(null);
        onHoverPointChange?.(null);
      }}
    >
      <title>{period === "intraday" ? "分时走势" : period === "daily" ? "日 K 走势" : "周 K 走势"}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="chart-grid">
        {gridValues.map((value, index) => {
          const y = yFor(value);
          return <g key={index}><line x1={plotLeft} x2={plotLeft + plotWidth} y1={y} y2={y} /><text x={plotLeft - 7} y={y + 3} textAnchor="end">{formatPrice(value)}</text></g>;
        })}
      </g>
      {reference >= minValue && reference <= maxValue && <g className="chart-reference"><line x1={plotLeft} x2={plotLeft + plotWidth} y1={yFor(reference)} y2={yFor(reference)} /><text x={plotLeft + 5} y={yFor(reference) - 5}>昨收 {formatPrice(reference)}</text></g>}
      {period === "intraday" ? (
        <g className="chart-line-group">
          <path className="chart-area" d={areaPath} fill={`url(#${gradientId})`} />
          <path className="chart-line" d={linePath} />
          <circle className="chart-last-point" cx={lastX} cy={yFor(drawablePoints.at(-1)?.close ?? reference)} r="3" />
        </g>
      ) : (
        <g className="chart-candles">
          {drawablePoints.map((point, index) => {
            const close = point.close ?? 0;
            const open = point.open ?? close;
            const high = point.high ?? Math.max(open, close);
            const low = point.low ?? Math.min(open, close);
            const candleTone = pointTone(point, index);
            const x = xForPoint(index);
            const bodyTop = Math.min(yFor(open), yFor(close));
            const bodyHeight = Math.max(1.5, Math.abs(yFor(open) - yFor(close)));
            return (
              <g className={`chart-candle ${candleTone}`} key={point.timestamp}>
                <line x1={x} x2={x} y1={yFor(high)} y2={yFor(low)} />
                <rect x={x - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} />
              </g>
            );
          })}
        </g>
      )}
      <g className="chart-volume">
        <line className="chart-volume-separator" x1={plotLeft} x2={plotLeft + plotWidth} y1={volumeTop - 5} y2={volumeTop - 5} />
        <line className="chart-volume-guide" x1={plotLeft} x2={plotLeft + plotWidth} y1={volumeBottom} y2={volumeBottom} />
        <text className="chart-volume-label" x={plotLeft + 5} y={volumeTop + 12}>成交量</text>
        <text className="chart-volume-scale" x={plotLeft - 7} y={volumeTop + 12} textAnchor="end">{formatCompactAmount(volumeMax)}</text>
        {drawablePoints.map((point, index) => {
          const volume = Math.max(point.volume ?? 0, 0);
          const x = xForData(index);
          const y = volumeFor(volume);
          return <rect className={`chart-volume-bar ${pointTone(point, index)} ${safeHoverIndex === index ? "active" : ""}`} key={point.timestamp} x={x - volumeBarWidth / 2} y={y} width={volumeBarWidth} height={Math.max(0, volumeBottom - y)} />;
        })}
      </g>
      {hoverPoint && hoverX !== null && hoverY !== null && crosshairPrice !== null && (
        <g className="chart-hover-layer">
          <g className={`chart-crosshair ${hoverTone}`}>
            <line x1={hoverX} x2={hoverX} y1={plotTop} y2={volumeBottom} />
            <line x1={plotLeft} x2={plotLeft + plotWidth} y1={hoverY} y2={hoverY} />
            <circle cx={hoverX} cy={hoverY} r="3.5" />
          </g>
          <g className="chart-crosshair-price-label" transform={`translate(${plotLeft - 46} ${crosshairPriceLabelY})`}>
            <rect width="42" height={crosshairPriceLabelHeight} rx="3" />
            <text x="21" y="11" textAnchor="middle">{formatPrice(crosshairPrice)}</text>
          </g>
        </g>
      )}
      <rect className="chart-interaction-layer" x={plotLeft} y={plotTop} width={plotWidth} height={volumeBottom - plotTop} aria-hidden="true" />
      <g className="chart-time-axis">
        {dateIndexes.map((index) => {
          const point = drawablePoints[index];
          return <text key={`${point.timestamp}-${index}`} x={xForData(index)} y={height - 9} textAnchor={index === 0 ? "start" : index === drawablePoints.length - 1 ? "end" : "middle"}>{formatChartTime(point.timestamp, period)}</text>;
        })}
      </g>
    </svg>
  );
}

function formatChartTime(timestamp: number, period: KlinePeriod): string {
  const options: Intl.DateTimeFormatOptions = period === "intraday"
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: "Asia/Shanghai" }).format(new Date(timestamp)).replaceAll("/", "-");
}

function formatChartTooltipTime(timestamp: number, period: KlinePeriod): string {
  const options: Intl.DateTimeFormatOptions = period === "intraday"
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: "Asia/Shanghai" }).format(new Date(timestamp)).replaceAll("/", "-");
}
