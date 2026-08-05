type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function looksLikeHtml(value: string) {
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(value);
}

function responseError(response: Response, label: string) {
  if (response.status === 401 || response.status === 403 || response.redirected) {
    return new Error(`Your Market Signal session expired before ${label} returned. Refresh this page, then run the scan again.`);
  }
  if (response.status >= 500) {
    return new Error(`${label} was temporarily interrupted before the result returned. Run the scan again.`);
  }
  return new Error(`${label} returned an unexpected service page instead of report data. Refresh this page, then run the scan again.`);
}

export function jsonResponseErrorMessage(error: unknown, label: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message || /failed to fetch|fetch failed|networkerror|network request failed|load failed|unexpected (?:end|token).*json/i.test(message)) {
    return `${label} was temporarily interrupted before the result returned. Try again in a moment.`;
  }
  return message;
}

export async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType) || looksLikeHtml(body)) {
    throw responseError(response, label);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${label} returned incomplete report data. Run the scan again.`);
  }
}

export async function postJson<T>(url: string, body: unknown, label: string, fetcher: FetchLike = fetch): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "MarketSignal",
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response, label);
}
