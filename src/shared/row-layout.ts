import type { RowField, RowLayout } from "./types";

export const ROW_FIELDS: RowField[] = [
  "name", "code", "trend", "changePercent", "price", "change",
  "amount", "turnover", "high", "low", "open", "prevClose", "volume", "marketCap", "floatMarketCap", "pe", "pb"
];

export const ROW_FIELD_LABELS: Record<RowField, string> = {
  name: "股票名称", code: "股票代码", trend: "分时线",
  changePercent: "涨跌幅", price: "现价", change: "涨跌额",
  amount: "成交额", turnover: "换手率", high: "最高价", low: "最低价",
  open: "今开", prevClose: "昨收", volume: "成交量", marketCap: "总市值",
  floatMarketCap: "流通市值", pe: "市盈率", pb: "市净率"
};

export const ROW_FIELD_SAMPLES: Record<RowField, string> = {
  name: "示例股票", code: "600172 · SH", trend: "",
  changePercent: "+2.19%", price: "34.47", change: "+0.74",
  amount: "额 19.08亿", turnover: "换 9.13%", high: "高 35.20", low: "低 33.80",
  open: "开 34.02", prevClose: "昨 33.73", volume: "量 1.26亿", marketCap: "市值 189亿",
  floatMarketCap: "流值 120亿", pe: "PE 25.30", pb: "PB 3.42"
};

export const DEFAULT_ROW_LAYOUT: RowLayout = {
  columns: [
    ["name", "code"],
    ["trend"],
    ["amount", "turnover"],
    ["changePercent", "price", "change"]
  ]
};
