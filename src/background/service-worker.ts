import { getDetail, getQuotes, searchStocks } from "../shared/eastmoney";
import type { ExtensionMessage, ExtensionResponse } from "../shared/types";

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse<unknown>> {
  switch (message.type) {
    case "search_stocks":
      return { ok: true, data: await searchStocks(message.keyword) };
    case "get_quotes":
      return { ok: true, data: await getQuotes(message.stocks, message.force ?? false) };
    case "get_detail":
      return { ok: true, data: await getDetail(message.stock) };
    default:
      return { ok: false, error: "不支持的后台消息" };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "行情服务暂时不可用";
      sendResponse({ ok: false, error: reason });
    });
  return true;
});
