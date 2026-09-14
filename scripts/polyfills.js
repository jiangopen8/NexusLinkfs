/**
 * Node.js 20 兼容性 Polyfill
 * 必须在所有其他模块之前导入
 */

// Promise.withResolvers polyfill (Node.js 22+ 原生支持)
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// WebSocket polyfill (Node.js 22+ 原生支持)
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const { WebSocket } = await import('ws');
    globalThis.WebSocket = WebSocket;
  } catch (e) {
    // ws 包不可用时，尝试 experimental flag 已启用的情况
  }
}

export {};
