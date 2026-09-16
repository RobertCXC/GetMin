import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { getEastmoneyUrl } from "../shared/eastmoney";
import {
  formatCompactAmount,
  formatDateTime,
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
  type Quote,
  type Stock,
  type StockGroup
} from "../shared/types";
import {
  getStockIdsForGroup,
  getStockMemberships,
  loadAppState,
  saveAppState
} from "../shared/storage";

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

type StateUpdater = (state: AppState) => AppState;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
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
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [addStock, setAddStock] = useState<Stock | null>(null);
  const [addStockGroupIds, setAddStockGroupIds] = useState<string[]>([]);
  const [addStockError, setAddStockError] = useState("");
  const [draggedStockId, setDraggedStockId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const searchRequestId = useRef(0);
  const quoteRequestId = useRef(0);
  const detailRequestId = useRef(0);
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
        const timestamps = nextQuotes.map((quote) => quote.updatedAt ?? 0).filter(Boolean);
        setLastUpdated(timestamps.length > 0 ? Math.max(...timestamps) : null);
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
        setLastUpdated(detail.updatedAt);
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

  useEffect(() => {
    if (view === "detail" && detailStock) {
      void loadDetail();
    }
  }, [detailStock, loadDetail, view]);

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
        : state.groups[0]?.id;
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
    const scopeLabel = removeFromAll ? "全部分组" : selectedGroup?.name ?? "当前分组";
    if (!window.confirm(`确定从${scopeLabel}移除“${stock.name}”吗？`)) {
      return;
    }

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
      order: state.groups.length
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
    updateState((currentState) => ({
      ...currentState,
      groups: currentState.groups
        .filter((item) => item.id !== groupId)
        .map((item, index) => ({ ...item, order: index })),
      selectedGroupId: currentState.selectedGroupId === groupId ? ALL_GROUP_ID : currentState.selectedGroupId
    }));
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
          loading={detailLoading}
          error={detailError}
          colorMode={state.settings.colorMode}
          onBack={() => {
            setView("list");
            setDetailStock(null);
          }}
          onRefresh={loadDetail}
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
  const currentMembershipCount = selectedGroup ? selectedGroup.stockIds.length : visibleStocks.length;
  const canDragStocks = state.selectedGroupId !== ALL_GROUP_ID;

  return (
    <main className="page-shell popup-shell">
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
          placeholder="搜索股票代码或名称"
          aria-label="搜索股票代码或名称"
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
          <button className={`group-tab ${state.selectedGroupId === ALL_GROUP_ID ? "active" : ""}`} type="button" role="tab" aria-selected={state.selectedGroupId === ALL_GROUP_ID} onClick={() => selectGroup(ALL_GROUP_ID)}>
            <span>全部自选</span><span className="tab-count">{visibleStocks.length}</span>
          </button>
          {state.groups.map((group) => (
            <button className={`group-tab ${state.selectedGroupId === group.id ? "active" : ""}`} type="button" role="tab" aria-selected={state.selectedGroupId === group.id} key={group.id} onClick={() => selectGroup(group.id)}>
              <span>{group.name}</span><span className="tab-count">{group.stockIds.length}</span>
            </button>
          ))}
          <button className="add-group-button" type="button" title="创建分组" onClick={() => setShowAddGroup(true)}>＋</button>
        </div>
        <button className="text-button manage-groups" type="button" onClick={() => setShowGroupManager(true)}>管理</button>
      </section>

      <section className="market-status-bar">
        <span>{currentGroupLabel} · {currentMembershipCount} 只</span>
        <span className="market-status-detail">
          {quoteLoading ? <span className="status-dot loading" /> : <span className={`status-dot ${apiError ? "error" : "ok"}`} />}
          {lastUpdated ? `更新于 ${formatDateTime(lastUpdated)}` : "等待行情更新"}
        </span>
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
          onClose={() => setShowGroupManager(false)}
          onRename={renameGroup}
          onDelete={deleteGroup}
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
      {!loading && !error && results.length === 0 && <p className="search-empty">没有找到沪深京 A 股</p>}
      {results.map((stock) => (
        <button className="search-result" type="button" key={stock.id} onClick={() => onSelect(stock)}>
          <span className="search-result-main"><strong>{stock.name}</strong><small>{stock.code} · {stock.market}</small></span>
          <span className={`search-result-state ${isAdded(stock.id) ? "added" : ""}`}>{isAdded(stock.id) ? "已添加" : "加入"}</span>
        </button>
      ))}
    </section>
  );
}

function StockRow({
  stock,
  quote,
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
  return (
    <div className={`stock-row ${tone}`} draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}>
      <button className="stock-row-main" type="button" onClick={onOpen}>
        <span className="stock-identity"><strong>{stock.name}</strong><small>{stock.code} · {stock.market}</small></span>
        <span className="stock-quote"><strong>{formatPrice(quote.price)}</strong><span className="quote-change"><span>{formatSignedNumber(quote.change)}</span><span>{formatPercent(quote.changePercent)}</span></span></span>
      </button>
      <span className={`quote-status ${quote.status}`}>{quoteStatusLabel(quote.status)}</span>
      <div className="row-actions">
        <button className="row-action" type="button" title="管理分组" onClick={(event) => { event.stopPropagation(); onManageGroups(); }}>分组</button>
        <button className="row-action danger" type="button" title="从当前分组移除" onClick={(event) => { event.stopPropagation(); onRemove(); }}>移除</button>
      </div>
    </div>
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

function GroupManagerDialog({
  groups,
  onClose,
  onRename,
  onDelete,
  onMove,
  onAdd
}: {
  groups: StockGroup[];
  onClose: () => void;
  onRename: (groupId: string, name: string) => boolean;
  onDelete: (groupId: string) => void;
  onMove: (fromGroupId: string, toGroupId: string) => void;
  onAdd: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((group) => [group.id, group.name])));
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  return (
    <Dialog title="管理分组" onClose={onClose} footer={<><button className="secondary-button" type="button" onClick={onClose}>完成</button><button className="primary-button" type="button" onClick={onAdd}>＋ 新建分组</button></>}>
      <p className="dialog-help">删除分组只会删除分组关系，不会删除股票。</p>
      <div className="managed-groups">
        {groups.map((group, index) => (
          <div
            className="managed-group"
            key={group.id}
            draggable
            onDragStart={() => setDraggedGroupId(group.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (draggedGroupId) onMove(draggedGroupId, group.id); setDraggedGroupId(null); }}
            onDragEnd={() => setDraggedGroupId(null)}
          >
            <span className="drag-handle" title="拖动排序">⠿</span>
            <div className="managed-group-fields">
              <input className="text-input" value={drafts[group.id] ?? group.name} maxLength={20} onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: event.target.value }))} />
              <small>{group.stockIds.length} 只股票{index === 0 ? " · 默认分组" : ""}</small>
            </div>
            <button className="row-action" type="button" onClick={() => { if (!onRename(group.id, drafts[group.id] ?? group.name)) setDrafts((current) => ({ ...current, [group.id]: group.name })); }}>保存</button>
            <button className="row-action danger" type="button" onClick={() => onDelete(group.id)}>删除</button>
          </div>
        ))}
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
      <div className="selected-stock-summary"><strong>{stock.name}</strong><span>{stock.code} · {stock.market}</span></div>
      <p className="dialog-help">同一只股票可以加入多个分组。</p>
      <div className="group-checkboxes">
        {groups.map((group) => (
          <label className="checkbox-row" key={group.id}>
            <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => onToggle(group.id)} />
            <span>{group.name}</span><small>{group.stockIds.length} 只</small>
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
  colorMode,
  onBack,
  onRefresh,
  onOpenExternal,
  onManageGroups,
  onRemove
}: {
  stock: Stock;
  quote: Quote;
  loading: boolean;
  error: string;
  colorMode: AppState["settings"]["colorMode"];
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onOpenExternal: () => void;
  onManageGroups: () => void;
  onRemove: () => void;
}) {
  const tone = getTone(quote.changePercent);
  const metricRows: Array<[string, string]> = [
    ["今开", formatPrice(quote.open)],
    ["最高", formatPrice(quote.high)],
    ["最低", formatPrice(quote.low)],
    ["昨收", formatPrice(quote.prevClose)],
    ["成交量", formatVolume(quote.volume)],
    ["成交额", formatCompactAmount(quote.amount)],
    ["换手率", formatPercent(quote.turnoverRate)],
    ["市盈率", formatNumberWithUnit(quote.pe)],
    ["市净率", formatNumberWithUnit(quote.pb)],
    ["总市值", formatCompactAmount(quote.marketCap)],
    ["流通市值", formatCompactAmount(quote.floatMarketCap)]
  ];
  return (
    <main className="page-shell popup-shell detail-shell">
      <header className="app-header detail-header">
        <button className="back-button" type="button" onClick={onBack}>← 返回列表</button>
        <div className="header-actions"><button className={`icon-button ${loading ? "is-loading" : ""}`} type="button" title="刷新详情" onClick={() => void onRefresh()} disabled={loading}>↻</button></div>
      </header>
      <section className="detail-hero">
        <div className="detail-identity"><p className="eyebrow">{stock.market} · {stock.code}</p><h1>{stock.name}</h1></div>
        <div className={`detail-price ${tone}`}><strong>{formatPrice(quote.price)}</strong><span>{formatSignedNumber(quote.change)}　{formatPercent(quote.changePercent)}</span></div>
      </section>
      <div className="detail-status"><span className={`quote-status ${quote.status}`}>{quoteStatusLabel(quote.status)}</span><span>行情更新时间：{formatDateTime(quote.updatedAt)}</span>{loading && <span className="inline-loading">刷新中…</span>}</div>
      {error && <div className="notice notice-warning"><span>{error}</span><button className="text-button" type="button" onClick={() => void onRefresh()}>重试</button></div>}
      <section className="metrics-grid">
        {metricRows.map(([label, value]) => <div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </section>
      <section className="detail-actions">
        <button className="secondary-button" type="button" onClick={onManageGroups}>加入其他分组</button>
        <button className="secondary-button" type="button" onClick={onOpenExternal}>东方财富网页</button>
        <button className="secondary-button danger-outline" type="button" onClick={onRemove}>从当前分组移除</button>
      </section>
      {colorMode === "china" && <p className="detail-footnote">红涨绿跌 · 第一版暂不包含 K 线图</p>}
    </main>
  );
}

function formatNumberWithUnit(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(2);
}
