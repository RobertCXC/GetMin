import type { ExtensionMessage, ExtensionResponse } from "./types";

export function sendExtensionMessage<T>(message: ExtensionMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("插件运行环境不可用"));
      return;
    }

    chrome.runtime.sendMessage(message, (response: ExtensionResponse<T> | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response || !response.ok) {
        reject(new Error(response?.error ?? "后台没有返回有效数据"));
        return;
      }

      resolve(response.data);
    });
  });
}
