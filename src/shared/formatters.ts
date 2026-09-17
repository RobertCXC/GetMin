import type { QuoteStatus } from "./types";

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const priceFormatter = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatPrice(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : priceFormatter.format(value);
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : numberFormatter.format(value);
}

export function formatSignedNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value > 0 ? "+" : ""}${numberFormatter.format(value)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatCompactAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(2)} 亿`;
  }
  if (absolute >= 10_000) {
    return `${(value / 10_000).toFixed(2)} 万`;
  }
  return formatNumber(value);
}

export function formatVolume(value: number | null | undefined): string {
  const formatted = formatCompactAmount(value);
  return formatted === "--" ? formatted : `${formatted} 手`;
}

export function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case "fresh":
      return "实时";
    case "stale":
      return "数据已过期";
    case "empty":
      return "暂无数据";
  }
}

export function getTone(value: number | null | undefined): "up" | "down" | "flat" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}
