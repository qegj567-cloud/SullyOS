import { diagnosticRunId, safeDiagnosticError, type DiagnosticEvent } from '../utils/amsgReproduction';

/** 仅包住库的通知出口；原生对象的方法保持正确 this，参数和返回值原样传递。 */
export function diagnosticNotificationScope<T extends { registration: { showNotification(title: string, options?: any): Promise<any> } }>(
  scope: T, record: (entry: DiagnosticEvent) => Promise<void>,
): T {
  const registration = new Proxy(scope.registration, {
    get(target, key) {
      if (key !== 'showNotification') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (title: string, options?: any) => {
        const payload = options?.data?.payload;
        const runId = diagnosticRunId(payload?.metadata);
        const log = async (event: string, extra: Record<string, unknown> = {}) => {
          if (!runId) return;
          try { await record({ runId, side: 'sw', event, ts: new Date().toISOString(), messageId: payload?.messageId, silent: options?.silent, renotify: options?.renotify, tag: options?.tag, ...extra }); } catch { /* 不改变通知结局 */ }
        };
        const callTrace = log('notification-call');
        try {
          const result = await target.showNotification(title, options);
          await Promise.all([callTrace, log('notification-resolved')]);
          return result;
        } catch (error) {
          await Promise.all([callTrace, log('notification-rejected', safeDiagnosticError(error))]);
          throw error;
        }
      };
    },
  });
  return new Proxy(scope, {
    get(target, key) {
      if (key === 'registration') return registration;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
