export const ALL_GROUP_ID = "all";

export type Theme = "light" | "dark" | "system";
export type ColorMode = "china" | "western";

export type Stock = {
  id: string;
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ" | string;
};

export type StockGroup = {
  id: string;
  name: string;
  stockIds: string[];
  order: number;
};

export type AppSettings = {
  refreshInterval: number;
  colorMode: ColorMode;
  theme: Theme;
};

export type AppState = {
  version: 1;
  stocks: Record<string, Stock>;
  groups: StockGroup[];
  selectedGroupId: string;
  settings: AppSettings;
};

export type QuoteStatus = "fresh" | "closed" | "stale" | "empty";

export type Quote = {
  secid: string;
  code: string;
  name: string;
  market: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  amount: number | null;
  turnoverRate: number | null;
  pe: number | null;
  pb: number | null;
  marketCap: number | null;
  floatMarketCap: number | null;
  updatedAt: number | null;
  status: QuoteStatus;
};

export type ExtensionMessage =
  | { type: "search_stocks"; keyword: string }
  | { type: "get_quotes"; stocks: Stock[]; force?: boolean }
  | { type: "get_detail"; stock: Stock };

export type ExtensionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
