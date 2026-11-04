// Device/site acknowledgement only. Deliberately excluded from personal backups.
export const DEPLOYMENT_NOTICE_KEY = 'sullyos_deployment_notice_v1_accepted';
let acceptedWithoutStorage = false;

export function hasAcceptedDeploymentNotice(): boolean {
  try {
    return acceptedWithoutStorage || localStorage.getItem(DEPLOYMENT_NOTICE_KEY) === '1';
  } catch {
    return acceptedWithoutStorage;
  }
}

export function acceptDeploymentNotice(): void {
  try {
    localStorage.setItem(DEPLOYMENT_NOTICE_KEY, '1');
  } catch {
    // Storage failure still allows this session to continue after acknowledgement.
    acceptedWithoutStorage = true;
  }
}
