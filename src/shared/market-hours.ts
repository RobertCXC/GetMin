import type { Stock } from "./types";

const marketZones: Record<string, string> = {
  SH: "Asia/Shanghai",
  SZ: "Asia/Shanghai",
  BJ: "Asia/Shanghai",
  HK: "Asia/Hong_Kong",
  KR: "Asia/Seoul"
};

const formatters: Record<string, Intl.DateTimeFormat> = Object.fromEntries(
  Object.entries(marketZones).map(([market, timeZone]) => [
    market,
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  ])
);

export function getMarketSession(stock: Stock, at = new Date()): { key: string; trading: boolean } {
  const parts = (formatters[stock.market] ?? formatters.SH).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const weekday = part("weekday");
  if (weekday === "Sat" || weekday === "Sun") return { key: `${date}:closed`, trading: false };

  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  const morningEnd = stock.market === "HK" ? 12 * 60 : 11 * 60 + 30;
  const afternoonEnd = stock.market === "HK" ? 16 * 60 + 10 : 15 * 60;
  let phase: string;
  if (stock.market === "KR") {
    phase = minutes < 9 * 60 ? "pre" : minutes <= 15 * 60 + 30 ? "trading" : "post";
  } else {
    phase = minutes < 9 * 60 + 30 ? "pre"
      : minutes <= morningEnd ? "morning"
        : minutes < 13 * 60 ? "lunch"
          : minutes <= afternoonEnd ? "afternoon" : "post";
  }
  return { key: `${date}:${phase}`, trading: phase === "morning" || phase === "afternoon" || phase === "trading" };
}

export function isMarketTradingNow(stock: Stock, at = new Date()): boolean {
  return getMarketSession(stock, at).trading;
}
