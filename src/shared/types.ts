export const ALL_GROUP_ID = "all";

export type Theme = "light" | "dark" | "system";
export type ColorMode = "china" | "western";
export type RowField =
  | "name" | "code" | "trend"
  | "changePercent" | "price" | "change"
  | "amount" | "turnover" | "high" | "low"
  | "open" | "prevClose" | "volume" | "marketCap" | "floatMarketCap" | "pe" | "pb";

export type RowLayout = {
  columns: RowField[][];
};

export type StockKind = "stock" | "etf";

export type Stock = {
  id: string;
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ" | "HK" | "KR" | string;
  kind: StockKind;
};

export type StockGroup = {
  id: string;
  name: string;
  stockIds: string[];
  order: number;
  hidden?: boolean;
};

export type AppSettings = {
  refreshInterval: number;
  colorMode: ColorMode;
  theme: Theme;
  rowLayout: RowLayout;
};

export type AppState = {
  version: 1;
  stocks: Record<string, Stock>;
  groups: StockGroup[];
  allGroupHidden: boolean;
  selectedGroupId: string;
  settings: AppSettings;
};

export type QuoteStatus = "fresh" | "stale" | "empty";

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

export type IntradayTrend = {
  secid: string;
  prevClose: number | null;
  prices: number[];
  points: KlinePoint[];
};

export type KlinePeriod = "intraday" | "daily" | "weekly";

export type KlinePoint = {
  timestamp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
};

export type KlineData = {
  secid: string;
  period: KlinePeriod;
  prevClose: number | null;
  points: KlinePoint[];
  updatedAt: number | null;
};

export type ExtensionMessage =
  | { type: "search_stocks"; keyword: string }
  | { type: "get_quotes"; stocks: Stock[]; force?: boolean }
  | { type: "get_trends"; stocks: Stock[] }
  | { type: "get_klines"; stock: Stock; period: KlinePeriod; force?: boolean }
  | { type: "get_detail"; stock: Stock };

export type ExtensionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
