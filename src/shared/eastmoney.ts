import type { IntradayTrend, KlineData, KlinePeriod, KlinePoint, Quote, Stock } from "./types";

const PUSH2_BASE = "https://push2.eastmoney.com";
const PUSH2HIS_BASE = "https://push2his.eastmoney.com";
const SEARCH_BASE = "https://searchapi.eastmoney.com";
const REQUEST_TIMEOUT_MS = 8_000;
const QUOTE_CACHE_TTL_MS = 8_000;
const TREND_CACHE_TTL_MS = 30_000;
const KLINE_CACHE_TTL_MS = 5 * 60_000;
const SUGGEST_TOKEN = "120c5a36c6c9b8c2cc5c3e5d1f7f7f4b";

type EastmoneyRecord = Record<string, unknown>;
type EastmoneyResponse = {
  data?: {
    diff?: EastmoneyRecord[] | Record<string, EastmoneyRecord>;
  } | EastmoneyRecord;
  rc?: number;
  msg?: string;
};

type CachedQuote = {
  quote: Quote;
  cachedAt: number;
};

const quoteCache = new Map<string, CachedQuote>();
const trendCache = new Map<string, { trend: IntradayTrend; cachedAt: number }>();
const klineCache = new Map<string, { data: KlineData; cachedAt: number }>();

function asRecord(value: unknown): EastmoneyRecord {
  return typeof value === "object" && value !== null ? (value as EastmoneyRecord) : {};
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value).trim() || null;
}

function codeValue(value: unknown): string | null {
  const raw = textValue(value);
  if (!raw || !/^\d+$/.test(raw) || raw.length > 6) {
    return raw;
  }
  return raw.padStart(6, "0");
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || value === "-" || value === "--") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function timestampValue(value: unknown): number | null {
  const raw = textValue(value);
  if (!raw) {
    return null;
  }

  const fullDate = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (fullDate) {
    const timestamp = new Date(
      Number(fullDate[1]),
      Number(fullDate[2]) - 1,
      Number(fullDate[3]),
      Number(fullDate[4] ?? 0),
      Number(fullDate[5] ?? 0),
      Number(fullDate[6] ?? 0)
    ).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeOnly) {
    return null;
  }
  const today = new Date();
  const timestamp = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    Number(timeOnly[1]),
    Number(timeOnly[2]),
    Number(timeOnly[3] ?? 0)
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function klinePointFromRow(row: string): KlinePoint | null {
  const values = row.split(",");
  const timestamp = timestampValue(values[0]);
  const close = numberValue(values[2]);
  if (timestamp === null || close === null) {
    return null;
  }
  return {
    timestamp,
    open: numberValue(values[1]),
    high: numberValue(values[3]),
    low: numberValue(values[4]),
    close,
    volume: numberValue(values[5]),
    amount: numberValue(values[6])
  };
}

function normalizeSecid(value: unknown, marketValue: unknown, rawCodeValue: unknown): string | null {
  const raw = textValue(value);
  if (raw) {
    const [rawMarket, rawCode] = raw.split(".");
    const normalizedRawCode = codeValue(rawCode);
    if (rawMarket && normalizedRawCode && /^(0|1)$/.test(rawMarket) && /^\d{6}$/.test(normalizedRawCode)) {
      return `${rawMarket}.${normalizedRawCode}`;
    }
  }

  const code = codeValue(rawCodeValue);
  if (!code || !/^\d{6}$/.test(code)) {
    return null;
  }

  const market = textValue(marketValue)?.toUpperCase();
  if (market === "SH" || market === "SSE" || market === "1") {
    return `1.${code}`;
  }
  if (market === "SZ" || market === "SZSE" || market === "BJ" || market === "BSE" || market === "0") {
    return `0.${code}`;
  }
  return null;
}

function marketFromSecid(secid: string, code: string): string {
  if (/^(4|8|92)/.test(code)) {
    return "BJ";
  }
  return secid.startsWith("1.") ? "SH" : "SZ";
}

function isOrdinaryAStock(record: EastmoneyRecord): boolean {
  const code = codeValue(record.f12 ?? record.Code);
  if (!code || !/^\d{6}$/.test(code)) {
    return false;
  }

  const classification = [record.Classify, record.SecurityTypeName, record.TypeName]
    .map(textValue)
    .filter(Boolean)
    .join(" ");
  if (/基金|ETF|债|指数|港|美|期货|期权|可转|权证/i.test(classification)) {
    return false;
  }

  const secid = normalizeSecid(record.QuoteID ?? record.secid ?? record.SecID, record.MktNum ?? record.f13 ?? record.Market, code);
  return Boolean(secid);
}

function stockFromRecord(record: EastmoneyRecord): Stock | null {
  const code = codeValue(record.f12 ?? record.Code);
  const name = textValue(record.f14 ?? record.Name);
  const secid = normalizeSecid(record.QuoteID ?? record.secid ?? record.SecID, record.MktNum ?? record.f13 ?? record.Market, code);
  if (!code || !name || !secid || !/^\d{6}$/.test(code)) {
    return null;
  }

  return {
    id: secid,
    code,
    name,
    market: marketFromSecid(secid, code)
  };
}

function getDiffRecords(response: EastmoneyResponse): EastmoneyRecord[] {
  const data = asRecord(response.data);
  const diff = data.diff;
  if (Array.isArray(diff)) {
    return diff.map(asRecord);
  }
  if (diff && typeof diff === "object") {
    return Object.values(diff).map(asRecord);
  }
  return [];
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`行情接口返回 HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("行情接口请求超时");
  }
  throw lastError instanceof Error ? lastError : new Error("行情接口请求失败");
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

function quoteFromRecord(stock: Stock, record: EastmoneyRecord, source: "batch" | "detail"): Quote {
  // The same field number can mean different things in the batch and detail APIs.
  // In particular, batch f43/f170 must not replace missing pre-market f2/f3.
  const batch = source === "batch";
  const price = numberValue(batch ? record.f2 : record.f43);
  const quote: Quote = {
    ...emptyQuote(stock),
    price,
    change: numberValue(batch ? record.f4 : record.f169),
    changePercent: numberValue(batch ? record.f3 : record.f170),
    open: numberValue(batch ? record.f17 : record.f46),
    high: numberValue(batch ? record.f15 : record.f44),
    low: numberValue(batch ? record.f16 : record.f45),
    prevClose: numberValue(batch ? record.f18 : record.f60),
    volume: numberValue(batch ? record.f5 : record.f47),
    amount: numberValue(batch ? record.f6 : record.f48),
    turnoverRate: numberValue(batch ? record.f8 : record.f168),
    pe: numberValue(batch ? record.f9 : record.f162),
    pb: numberValue(batch ? record.f23 : record.f167),
    marketCap: numberValue(batch ? record.f20 : record.f116),
    floatMarketCap: numberValue(batch ? record.f21 : record.f117),
    updatedAt: Date.now(),
    status: price === null ? "empty" : "fresh"
  };
  return quote;
}

function searchUrl(keyword: string): string {
  const params = new URLSearchParams({
    input: keyword,
    type: "14",
    token: SUGGEST_TOKEN,
    count: "20"
  });
  return `${SEARCH_BASE}/api/suggest/get?${params.toString()}`;
}

function listUrl(): string {
  const params = new URLSearchParams({
    pn: "1",
    pz: "10000",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81",
    fields: "f12,f13,f14,f100"
  });
  return `${PUSH2_BASE}/api/qt/clist/get?${params.toString()}`;
}

function parseSuggestionResponse(response: unknown): Stock[] {
  const root = asRecord(response);
  const table = asRecord(root.QuotationCodeTable ?? root.quotationCodeTable);
  const data = Array.isArray(table.Data) ? table.Data : [];
  return data
    .map(asRecord)
    .filter(isOrdinaryAStock)
    .map(stockFromRecord)
    .filter((stock): stock is Stock => stock !== null);
}

function dedupeStocks(stocks: Stock[]): Stock[] {
  const seen = new Set<string>();
  return stocks.filter((stock) => {
    if (seen.has(stock.id)) {
      return false;
    }
    seen.add(stock.id);
    return true;
  });
}

export async function searchStocks(keyword: string): Promise<Stock[]> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }

  try {
    const suggestionResults = dedupeStocks(parseSuggestionResponse(await fetchJson(searchUrl(normalizedKeyword))));
    if (suggestionResults.length > 0) {
      return suggestionResults.slice(0, 20);
    }
  } catch {
    // The suggestion endpoint is not stable across regions; fall back to the A-share list below.
  }

  const records = getDiffRecords(await fetchJson<EastmoneyResponse>(listUrl()));
  const needle = normalizedKeyword.toLowerCase();
  return dedupeStocks(
    records
      .filter(isOrdinaryAStock)
      .map(stockFromRecord)
      .filter((stock): stock is Stock => stock !== null)
      .filter((stock) => stock.code.includes(needle) || stock.name.toLowerCase().includes(needle))
  ).slice(0, 20);
}

function quoteUrl(secids: string[]): string {
  const params = new URLSearchParams({
    fltt: "2",
    invt: "2",
    fields: "f2,f3,f4,f5,f6,f8,f9,f11,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f43,f44,f45,f46,f47,f48,f51,f60,f116,f117,f162,f167,f168,f169,f170",
    secids: secids.join(",")
  });
  return `${PUSH2_BASE}/api/qt/ulist.np/get?${params.toString()}`;
}

function detailUrl(secid: string): string {
  const params = new URLSearchParams({
    invt: "2",
    fltt: "2",
    fields: "f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170",
    secid
  });
  return `${PUSH2_BASE}/api/qt/stock/get?${params.toString()}`;
}

function trendUrl(secid: string): string {
  const params = new URLSearchParams({
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
    ut: "7eea3edcaed734bea9cbfc24409ed989",
    ndays: "1",
    iscr: "0",
    iscca: "0",
    secid
  });
  return `${PUSH2HIS_BASE}/api/qt/stock/trends2/get?${params.toString()}`;
}

function klineUrl(secid: string, period: Exclude<KlinePeriod, "intraday">): string {
  const params = new URLSearchParams({
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62",
    ut: "7eea3edcaed734bea9cbfc24409ed989",
    klt: period === "weekly" ? "102" : "101",
    fqt: "1",
    beg: "0",
    end: "20500000",
    lmt: "160",
    secid
  });
  return `${PUSH2HIS_BASE}/api/qt/stock/kline/get?${params.toString()}`;
}

async function fetchTrend(stock: Stock): Promise<IntradayTrend> {
  const payload = await fetchJson<EastmoneyResponse>(trendUrl(stock.id));
  const data = asRecord(payload.data);
  const rows = Array.isArray(data.trends) ? data.trends : [];
  const points = rows
    .filter((row): row is string => typeof row === "string")
    .map((row): KlinePoint | null => {
      const values = row.split(",");
      const timestamp = timestampValue(values[0]);
      const open = numberValue(values[1]);
      const close = numberValue(values[2], values[1]);
      if (timestamp === null || close === null || close <= 0) {
        return null;
      }
      return {
        timestamp,
        open: open ?? close,
        high: numberValue(values[3], close),
        low: numberValue(values[4], close),
        close,
        volume: numberValue(values[5]),
        amount: numberValue(values[6])
      };
    })
    .filter((point): point is KlinePoint => point !== null);
  return {
    secid: stock.id,
    prevClose: numberValue(data.prePrice, data.preClose, data.preclose),
    prices: points.map((point) => point.close ?? 0).filter((price) => price > 0),
    points
  };
}

async function fetchKline(stock: Stock, period: Exclude<KlinePeriod, "intraday">): Promise<KlineData> {
  const payload = await fetchJson<EastmoneyResponse>(klineUrl(stock.id, period));
  const data = asRecord(payload.data);
  const rows = Array.isArray(data.klines) ? data.klines : [];
  return {
    secid: stock.id,
    period,
    prevClose: numberValue(data.prePrice, data.preClose, data.preclose),
    points: rows
      .filter((row): row is string => typeof row === "string")
      .map(klinePointFromRow)
      .filter((point): point is KlinePoint => point !== null),
    updatedAt: Date.now()
  };
}

export async function getTrends(stocks: Stock[]): Promise<IntradayTrend[]> {
  const uniqueStocks = dedupeStocks(stocks);
  const result = new Map<string, IntradayTrend>();
  const missing = uniqueStocks.filter((stock) => {
    const cached = trendCache.get(stock.id);
    if (cached && Date.now() - cached.cachedAt < TREND_CACHE_TTL_MS) {
      result.set(stock.id, cached.trend);
      return false;
    }
    return true;
  });

  // A group can contain 100 stocks; keep requests bounded and isolate individual failures.
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (nextIndex < missing.length) {
      const stock = missing[nextIndex++];
      try {
        const trend = await fetchTrend(stock);
        trendCache.set(stock.id, { trend, cachedAt: Date.now() });
        result.set(stock.id, trend);
      } catch {
        const cached = trendCache.get(stock.id);
        result.set(stock.id, cached?.trend ?? { secid: stock.id, prevClose: null, prices: [], points: [] });
      }
    }
  }));

  return uniqueStocks.map((stock) => result.get(stock.id) ?? { secid: stock.id, prevClose: null, prices: [], points: [] });
}

export async function getKlines(stock: Stock, period: KlinePeriod, force = false): Promise<KlineData> {
  const cacheKey = `${stock.id}:${period}`;
  const cached = klineCache.get(cacheKey);
  const now = Date.now();
  const cacheTtl = period === "intraday" ? TREND_CACHE_TTL_MS : KLINE_CACHE_TTL_MS;
  if (!force && cached && now - cached.cachedAt <= cacheTtl) {
    return cached.data;
  }

  let data: KlineData;
  if (period === "intraday") {
    const trend = await fetchTrend(stock);
    trendCache.set(stock.id, { trend, cachedAt: now });
    data = {
      secid: stock.id,
      period,
      prevClose: trend.prevClose,
      points: trend.points,
      updatedAt: now
    };
  } else {
    data = await fetchKline(stock, period);
  }

  klineCache.set(cacheKey, { data, cachedAt: now });
  return data;
}

export async function getQuotes(stocks: Stock[], force = false): Promise<Quote[]> {
  const uniqueStocks = dedupeStocks(stocks);
  const now = Date.now();
  const result = new Map<string, Quote>();
  const missing: Stock[] = [];

  for (const stock of uniqueStocks) {
    const cached = quoteCache.get(stock.id);
    if (!force && cached && now - cached.cachedAt <= QUOTE_CACHE_TTL_MS) {
      result.set(stock.id, cached.quote);
    } else {
      missing.push(stock);
    }
  }

  if (missing.length > 0) {
    const payload = await fetchJson<EastmoneyResponse>(quoteUrl(missing.map((stock) => stock.id)));
    const records = getDiffRecords(payload);
    const recordsBySecid = new Map<string, EastmoneyRecord>();
    for (const record of records) {
      const code = textValue(record.f12);
      const secid = normalizeSecid(undefined, record.f13, code);
      if (secid) {
        recordsBySecid.set(secid, record);
      }
    }

    for (const stock of missing) {
      const quote = quoteFromRecord(stock, recordsBySecid.get(stock.id) ?? {}, "batch");
      quoteCache.set(stock.id, { quote, cachedAt: now });
      result.set(stock.id, quote);
    }
  }

  return uniqueStocks.map((stock) => result.get(stock.id) ?? emptyQuote(stock));
}

export async function getDetail(stock: Stock): Promise<Quote> {
  const payload = await fetchJson<EastmoneyResponse>(detailUrl(stock.id));
  const record = asRecord(payload.data);
  const quote = quoteFromRecord(stock, record, "detail");
  quoteCache.set(stock.id, { quote, cachedAt: Date.now() });
  return quote;
}

export function getEastmoneyUrl(stock: Stock): string {
  return `https://quote.eastmoney.com/${stock.market.toLowerCase()}${stock.code}.html`;
}

export function clearQuoteCache(): void {
  quoteCache.clear();
  trendCache.clear();
  klineCache.clear();
}
