import type { IntradayTrend, KlineData, KlinePeriod, KlinePoint, Quote, Stock, StockKind } from "./types";

const PUSH2_BASE = "https://push2.eastmoney.com";
const PUSH2HIS_BASE = "https://push2his.eastmoney.com";
const SEARCH_BASE = "https://searchapi.eastmoney.com";
const REQUEST_TIMEOUT_MS = 8_000;
const QUOTE_CACHE_TTL_MS = 8_000;
const TREND_CACHE_TTL_MS = 30_000;
const KLINE_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_LIST_CACHE_TTL_MS = 10 * 60_000;
const SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";

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

type SearchListConfig = {
  key: string;
  fs: string;
  kind: StockKind;
  filter?: (record: EastmoneyRecord) => boolean;
};

type CachedStockList = {
  stocks: Stock[];
  cachedAt: number;
};

const quoteCache = new Map<string, CachedQuote>();
const trendCache = new Map<string, { trend: IntradayTrend; cachedAt: number }>();
const klineCache = new Map<string, { data: KlineData; cachedAt: number }>();
const searchListCache = new Map<string, CachedStockList>();

function asRecord(value: unknown): EastmoneyRecord {
  return typeof value === "object" && value !== null ? (value as EastmoneyRecord) : {};
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value).trim() || null;
}

function rawCodeValue(value: unknown): string | null {
  return textValue(value);
}

function normalizeMarketId(value: unknown): string | null {
  const raw = textValue(value)?.toUpperCase();
  if (!raw) {
    return null;
  }

  switch (raw) {
    case "SH":
    case "SSE":
    case "1":
      return "1";
    case "SZ":
    case "SZSE":
    case "BJ":
    case "BSE":
    case "0":
      return "0";
    case "HK":
    case "HKS":
    case "HKEX":
    case "116":
      return "116";
    case "KR":
    case "KOREA":
    case "KOSPI":
    case "KOSDAQ":
    case "177":
      return "177";
    default:
      return null;
  }
}

function normalizeCodeForMarket(value: unknown, market: string | null): string | null {
  const raw = rawCodeValue(value);
  if (!raw) {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    return raw;
  }

  const expectedLength = market === "116" ? 5 : 6;
  return raw.length <= expectedLength ? raw.padStart(expectedLength, "0") : raw;
}

function validCodeForMarket(code: string, market: string): boolean {
  return market === "116" ? /^\d{5}$/.test(code) : /^\d{6}$/.test(code);
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
    const market = normalizeMarketId(rawMarket);
    const normalizedRawCode = normalizeCodeForMarket(rawCode, market);
    if (market && normalizedRawCode && validCodeForMarket(normalizedRawCode, market)) {
      return `${market}.${normalizedRawCode}`;
    }
  }

  const market = normalizeMarketId(marketValue);
  const code = normalizeCodeForMarket(rawCodeValue, market);
  if (!market || !code || !validCodeForMarket(code, market)) {
    return null;
  }
  return `${market}.${code}`;
}

function marketFromSecid(secid: string, code: string): string {
  if (secid.startsWith("116.")) {
    return "HK";
  }
  if (secid.startsWith("177.")) {
    return "KR";
  }
  if (/^(4|8|92)/.test(code)) {
    return "BJ";
  }
  return secid.startsWith("1.") ? "SH" : "SZ";
}

function classificationText(record: EastmoneyRecord): string {
  return [
    record.Classify,
    record.SecurityTypeName,
    record.SecurityType,
    record.TypeName,
    record.f14,
    record.Name
  ]
    .map(textValue)
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function isEtfRecord(record: EastmoneyRecord): boolean {
  return /ETF/i.test(classificationText(record));
}

function isExcludedSecurity(record: EastmoneyRecord): boolean {
  return /基金|债券?|指数|期货|期权|可转|权证|窝轮|牛熊|REIT/i.test(classificationText(record)) && !isEtfRecord(record);
}

function isOrdinaryAStock(record: EastmoneyRecord): boolean {
  const stock = stockFromRecord(record, "stock");
  if (!stock || !["SH", "SZ", "BJ"].includes(stock.market) || isEtfRecord(record) || isExcludedSecurity(record)) {
    return false;
  }
  return true;
}

function stockFromRecord(record: EastmoneyRecord, kindOverride?: StockKind): Stock | null {
  const rawCode = record.f12 ?? record.f57 ?? record.Code;
  const name = textValue(record.f14 ?? record.f58 ?? record.Name);
  const secid = normalizeSecid(record.QuoteID ?? record.secid ?? record.SecID, record.MktNum ?? record.f13 ?? record.Market, rawCode);
  const code = secid?.split(".")[1] ?? normalizeCodeForMarket(rawCode, null);
  if (!code || !name || !secid || !validCodeForMarket(code, secid.split(".")[0])) {
    return null;
  }

  const kind = kindOverride ?? (isEtfRecord(record) ? "etf" : isExcludedSecurity(record) ? null : "stock");
  if (!kind) {
    return null;
  }

  return {
    id: secid,
    code,
    name,
    market: marketFromSecid(secid, code),
    kind
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
      const body = (await response.text()).trim();
      try {
        return JSON.parse(body) as T;
      } catch {
        // The suggestion endpoint can return JSONP in some browser regions.
        const jsonp = body.match(/^[^(]+\(([\s\S]*)\)\s*;?$/);
        if (!jsonp) {
          throw new Error("行情接口返回格式无法识别");
        }
        return JSON.parse(jsonp[1]) as T;
      }
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

function listUrl(fs: string): string {
  const params = new URLSearchParams({
    pn: "1",
    pz: "10000",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs,
    fields: "f12,f13,f14,f100"
  });
  return `${PUSH2_BASE}/api/qt/clist/get?${params.toString()}`;
}

const searchListConfigs: readonly SearchListConfig[] = [
  {
    key: "a-stock",
    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81",
    kind: "stock",
    filter: isOrdinaryAStock
  },
  {
    key: "etf",
    fs: "b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827",
    kind: "etf"
  },
  {
    key: "hk-stock",
    fs: "m:116+t:3,m:116+t:4",
    kind: "stock"
  },
  {
    key: "kr-stock",
    fs: "m:177",
    kind: "stock"
  }
];

function parseSuggestionResponse(response: unknown): Stock[] {
  const root = asRecord(response);
  const table = asRecord(root.QuotationCodeTable ?? root.quotationCodeTable);
  const data = Array.isArray(table.Data) ? table.Data : [];
  return data
    .map(asRecord)
    .map((record) => stockFromRecord(record))
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

function searchNeedle(keyword: string): string {
  return keyword
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(?:hk|港股)[:._-]?/i, "")
    .replace(/[:._-](?:hk|ks|kq|kr)$/i, "");
}

function explicitKoreanCode(keyword: string): string | null {
  const raw = keyword.trim().toUpperCase().replace(/\s+/g, "");
  return raw.match(/^(\d{6})\.(?:KS|KQ|KR)$/)?.[1]
    ?? raw.match(/^KR[:._-]?(\d{6})$/)?.[1]
    ?? null;
}

function explicitHongKongCode(keyword: string): string | null {
  const raw = keyword.trim().toUpperCase().replace(/\s+/g, "");
  return raw.match(/^(?:HK[:._-]?)?(\d{1,5})(?:\.HK)?$/)?.[1] ?? null;
}

function searchConfigsForKeyword(keyword: string): SearchListConfig[] {
  if (explicitKoreanCode(keyword)) {
    return searchListConfigs.filter((config) => config.key === "kr-stock");
  }
  if (explicitHongKongCode(keyword)) {
    return searchListConfigs.filter((config) => config.key === "hk-stock");
  }
  if (/ETF/i.test(keyword)) {
    return searchListConfigs.filter((config) => config.key === "etf");
  }
  return [...searchListConfigs];
}

function isSearchContextMatch(stock: Stock, keyword: string): boolean {
  if (/ETF/i.test(keyword) && stock.kind !== "etf") {
    return false;
  }
  if (explicitKoreanCode(keyword)) {
    return stock.market === "KR";
  }
  if (explicitHongKongCode(keyword)) {
    return stock.market === "HK";
  }
  return true;
}

function searchScore(stock: Stock, needle: string): number {
  const code = stock.code.toLowerCase();
  const name = stock.name.toLowerCase();
  if (code === needle || name === needle) return 0;
  if (code.startsWith(needle) || name.startsWith(needle)) return 1;
  if (code.includes(needle) || name.includes(needle)) return 2;
  return 3;
}

async function loadSearchList(config: SearchListConfig): Promise<Stock[]> {
  const cached = searchListCache.get(config.key);
  const now = Date.now();
  if (cached && now - cached.cachedAt < SEARCH_LIST_CACHE_TTL_MS) {
    return cached.stocks;
  }

  const records = getDiffRecords(await fetchJson<EastmoneyResponse>(listUrl(config.fs)));
  const stocks = dedupeStocks(
    records
      .filter(config.filter ?? (() => true))
      .map((record) => stockFromRecord(record, config.kind))
      .filter((stock): stock is Stock => stock !== null)
  );
  searchListCache.set(config.key, { stocks, cachedAt: now });
  return stocks;
}

async function searchFromLists(keyword: string): Promise<Stock[]> {
  const needle = searchNeedle(keyword);
  const configs = searchConfigsForKeyword(keyword);
  const settled = await Promise.allSettled(configs.map((config) => loadSearchList(config)));
  const stocks = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (stocks.length === 0 && settled.every((result) => result.status === "rejected")) {
    throw new Error("行情搜索接口暂时不可用");
  }

  return dedupeStocks(
    stocks
      .filter((stock) => isSearchContextMatch(stock, keyword))
      .filter((stock) => stock.code.toLowerCase().includes(needle) || stock.name.toLowerCase().includes(needle))
      .sort((left, right) => searchScore(left, needle) - searchScore(right, needle))
  ).slice(0, 20);
}

async function searchExplicitSecurity(keyword: string): Promise<Stock[]> {
  let secid: string | null = null;
  const koreanCode = explicitKoreanCode(keyword);
  const hongKongCode = explicitHongKongCode(keyword);
  if (koreanCode) {
    const code = koreanCode;
    secid = `177.${code}`;
  } else if (hongKongCode) {
    const code = hongKongCode;
    secid = `116.${code.padStart(5, "0")}`;
  }
  if (!secid) {
    return [];
  }

  try {
    const payload = await fetchJson<EastmoneyResponse>(detailUrl(secid));
    const stock = stockFromRecord({ ...asRecord(payload.data), QuoteID: secid }, "stock");
    return stock ? [stock] : [];
  } catch {
    return [];
  }
}

export async function searchStocks(keyword: string): Promise<Stock[]> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }

  try {
    const suggestionResults = dedupeStocks(
      parseSuggestionResponse(await fetchJson(searchUrl(normalizedKeyword)))
        .filter((stock) => isSearchContextMatch(stock, normalizedKeyword))
    );
    if (suggestionResults.length > 0) {
      return suggestionResults.slice(0, 20);
    }
  } catch {
    // The suggestion endpoint is not stable across regions; fall back to the market lists below.
  }

  let listError: unknown;
  try {
    const listResults = await searchFromLists(normalizedKeyword);
    if (listResults.length > 0) {
      return listResults;
    }
  } catch (error) {
    listError = error;
  }

  const explicitResults = await searchExplicitSecurity(normalizedKeyword);
  if (explicitResults.length > 0) {
    return explicitResults;
  }
  if (listError instanceof Error) {
    throw listError;
  }
  return [];
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
  // The canonical q/{secid} route also works for ETF, HK (116.xxxxx), and KR (177.xxxxxx).
  return `https://quote.eastmoney.com/q/${encodeURIComponent(stock.id)}.html`;
}

export function clearQuoteCache(): void {
  quoteCache.clear();
  trendCache.clear();
  klineCache.clear();
}
