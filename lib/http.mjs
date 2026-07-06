// 带重试的 fetch —— 兜住瞬时网络抖动（连接超时、fetch failed 等）
export async function fetchRetry(url, options = {}, { retries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      // fetch 只在网络层失败时抛错（HTTP 4xx/5xx 不抛），所以抛错即值得重试
      lastErr = e;
      if (i === retries) break;
      const reason = e.cause?.code || e.cause?.message || e.message;
      console.warn(`  ⚠️ 请求失败(${reason})，第 ${i + 1}/${retries} 次重试...`);
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}

// 并发映射：最多 concurrency 个任务同时进行，保持结果顺序。
// 单个任务抛错不影响其它，结果位置放 { __error: err }（由调用方决定如何处理）。
export async function pMap(items, fn, concurrency = 6) {
  const ret = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        ret[i] = await fn(items[i], i);
      } catch (e) {
        ret[i] = { __error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return ret;
}

