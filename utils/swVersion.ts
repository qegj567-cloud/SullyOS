/**
 * 查询当前激活 Service Worker 的版本号。
 *
 * 通过 MessageChannel + postMessage 的 GET_SW_VERSION 协议向 SW 询问，
 * SW 在 worker/sw-keep-alive.ts 里用 event.ports[0].postMessage({ version }) 回包。
 *
 * 1.5s 总超时通过 race 整个流程实现，避免 `navigator.serviceWorker.ready`
 * 在没有 SW 接管页面时（隐私模式、浏览器禁用 SW、首次注册完成前）永远 pending
 * 让调用方一直挂着。
 *
 * 释放：finally 里 clearTimeout 并 channel.port1.close()——timeout 赢的情况下
 * 内部 Promise 永不 settle，不主动关 port 会让 MessageChannel + onmessage 闭包
 * 一直挂内存里，BuildBadge / VersionInfo 反复挂载会累积。
 *
 * BuildBadge（右下角开发指示器）与 Settings 底部的版本信息都复用这个函数。
 */
const SW_QUERY_TIMEOUT_MS = 1500;

export async function querySwVersion(): Promise<string> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return '?';

    let channel: MessageChannel | undefined;
    let timer: number | undefined;
    // hasTimedOut：保护「ready 永远 pending → timeout 赢 → finally 已跑」之后 ready 才
    // 终于 resolve 的场景。channel = new MessageChannel() 在 await 之后才发生，
    // 此时 finally 已经过去、再也不会 close()——形成"延迟泄漏"。
    let hasTimedOut = false;

    const query = (async (): Promise<string> => {
        const reg = await navigator.serviceWorker.ready;
        if (hasTimedOut) return '?';
        const target = reg.active || reg.waiting || reg.installing;
        if (!target) return '?';
        channel = new MessageChannel();
        return await new Promise<string>((resolve) => {
            channel!.port1.onmessage = (e) => resolve(e.data?.version ?? '?');
            target.postMessage({ type: 'GET_SW_VERSION' }, [channel!.port2]);
        });
    })();

    const timeout = new Promise<string>((resolve) => {
        timer = window.setTimeout(() => {
            hasTimedOut = true;
            resolve('?');
        }, SW_QUERY_TIMEOUT_MS);
    });

    try {
        return await Promise.race([query, timeout]);
    } catch {
        return '?';
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        // 关掉 port1：query 赢时已 resolve，关掉无害；timeout 赢时让内部 Promise
        // 永远不会再被外面持有，port + onmessage 闭包可被 GC。
        channel?.port1.close();
    }
}
