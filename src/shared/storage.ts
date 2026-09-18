import { DEFAULT_ROW_LAYOUT, ROW_FIELDS } from "./row-layout";
import { ALL_GROUP_ID, type AppSettings, type AppState, type RowField, type RowLayout, type Stock, type StockGroup } from "./types";

export const STORAGE_KEY = "stock-market-app-state";
export const STATE_VERSION = 1 as const;

const DEFAULT_GROUP_ID = "group-default";
const DEFAULT_GROUP_NAME = "我的自选";
export function normalizeRowLayout(value: unknown): RowLayout {
  const raw = isRecord(value) ? value : {};
  let source: unknown[];
  if (Array.isArray(raw.columns)) {
    source = raw.columns;
  } else if (Array.isArray(raw.blockOrder)) {
    // Keep layouts saved by the earlier list-based settings editor.
    const blocks: Record<string, RowField[]> = {
      identity: ["name", "code"], trend: ["trend"], metrics: ["amount", "turnover"],
      quote: (Array.isArray(raw.quoteOrder) ? raw.quoteOrder : ["changePercent", "price", "change"])
        .filter((field): field is RowField => ROW_FIELDS.includes(field as RowField))
        .filter((field) => !Array.isArray(raw.hiddenQuoteFields) || !raw.hiddenQuoteFields.includes(field))
    };
    source = raw.blockOrder
      .filter((block): block is string => typeof block === "string" && Object.hasOwn(blocks, block))
      .filter((block) => !Array.isArray(raw.hiddenBlocks) || !raw.hiddenBlocks.includes(block))
      .map((block) => blocks[block]);
  } else {
    source = DEFAULT_ROW_LAYOUT.columns;
  }

  const seen = new Set<RowField>();
  const columns = Array.from({ length: 4 }, (_, index) => {
    const column = Array.isArray(source[index]) ? source[index] : [];
    return column.filter((field): field is RowField => {
      if (!ROW_FIELDS.includes(field as RowField) || seen.has(field as RowField)) return false;
      seen.add(field as RowField);
      return true;
    });
  });
  if (seen.size === 0) columns[0].push("name");
  return { columns };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createDefaultGroup(): StockGroup {
  return {
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    stockIds: [],
    order: 0,
    hidden: false
  };
}

export function createDefaultState(): AppState {
  return {
    version: STATE_VERSION,
    stocks: {},
    groups: [createDefaultGroup()],
    allGroupHidden: false,
    selectedGroupId: ALL_GROUP_ID,
    settings: {
      refreshInterval: 10,
      colorMode: "china",
      theme: "system",
      rowLayout: normalizeRowLayout(null)
    }
  };
}

function normalizeStock(value: unknown, fallbackId: string): Stock | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id.includes(".") ? value.id : fallbackId;
  const code = typeof value.code === "string" ? value.code.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const market = typeof value.market === "string" ? value.market.trim() : "";
  const kind = value.kind === "etf" ? "etf" : "stock";

  if (!id || !code || !name || !market) {
    return null;
  }

  return { id, code, name, market, kind };
}

function normalizeSettings(value: unknown): AppSettings {
  const defaults = createDefaultState().settings;
  if (!isRecord(value)) {
    return defaults;
  }

  const interval = typeof value.refreshInterval === "number" ? value.refreshInterval : defaults.refreshInterval;
  const colorMode = value.colorMode === "western" ? "western" : "china";
  const theme = value.theme === "light" || value.theme === "dark" ? value.theme : "system";

  return {
    refreshInterval: Math.min(60, Math.max(5, Math.round(interval))),
    colorMode,
    theme,
    rowLayout: normalizeRowLayout(value.rowLayout)
  };
}

export function normalizeState(value: unknown): AppState {
  const defaults = createDefaultState();
  if (!isRecord(value)) {
    return defaults;
  }

  const stocks: Record<string, Stock> = {};
  if (isRecord(value.stocks)) {
    for (const [fallbackId, rawStock] of Object.entries(value.stocks)) {
      const stock = normalizeStock(rawStock, fallbackId);
      if (stock) {
        stocks[stock.id] = stock;
      }
    }
  }

  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  const groups = rawGroups
    .filter(isRecord)
    .map((rawGroup, index): StockGroup | null => {
      const id = typeof rawGroup.id === "string" && rawGroup.id.trim() ? rawGroup.id.trim() : `group-${index + 1}`;
      const name = typeof rawGroup.name === "string" && rawGroup.name.trim() ? rawGroup.name.trim() : `分组 ${index + 1}`;
      const rawStockIds = Array.isArray(rawGroup.stockIds) ? rawGroup.stockIds : [];
      const stockIds = rawStockIds.filter((stockId): stockId is string => typeof stockId === "string" && Boolean(stocks[stockId]));
      const order = typeof rawGroup.order === "number" ? rawGroup.order : index;
      const hidden = Boolean(rawGroup.hidden);
      return { id, name, stockIds: [...new Set(stockIds)], order, hidden };
    })
    .filter((group): group is StockGroup => group !== null)
    .sort((left, right) => left.order - right.order)
    .map((group, index) => ({ ...group, order: index }));

  if (groups.length === 0) {
    groups.push(createDefaultGroup());
  }

  const selectedGroupId =
    value.selectedGroupId === ALL_GROUP_ID || groups.some((group) => group.id === value.selectedGroupId)
      ? String(value.selectedGroupId)
      : ALL_GROUP_ID;

  return {
    version: STATE_VERSION,
    stocks,
    groups,
    allGroupHidden: value.allGroupHidden === true,
    selectedGroupId,
    settings: normalizeSettings(value.settings)
  };
}

export async function loadAppState(): Promise<AppState> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return createDefaultState();
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

export async function saveAppState(state: AppState): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: normalizeState(state) });
}

export function getStockIdsForGroup(state: AppState, groupId: string): string[] {
  if (groupId === ALL_GROUP_ID) {
    const result: string[] = [];
    const seen = new Set<string>();
    const visibleGroups = state.groups.filter((group) => !group.hidden);
    for (const group of [...visibleGroups].sort((left, right) => left.order - right.order)) {
      for (const stockId of group.stockIds) {
        if (!seen.has(stockId) && state.stocks[stockId]) {
          seen.add(stockId);
          result.push(stockId);
        }
      }
    }
    return result;
  }

  return state.groups.find((group) => group.id === groupId)?.stockIds.filter((stockId) => Boolean(state.stocks[stockId])) ?? [];
}

export function getStockMemberships(state: AppState, stockId: string): StockGroup[] {
  return state.groups.filter((group) => group.stockIds.includes(stockId));
}
