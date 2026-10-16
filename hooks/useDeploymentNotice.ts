import { useEffect, useState } from 'react';
import { acceptDeploymentNotice, hasAcceptedDeploymentNotice } from '../utils/deploymentNotice';
import { detectDeploymentSource, type DeploymentSource } from '../utils/deploymentSource';

export function useDeploymentNotice() {
  const [accepted, setAccepted] = useState(hasAcceptedDeploymentNotice);
  const [source, setSource] = useState<DeploymentSource | 'checking'>('checking');

  useEffect(() => {
    if (accepted) return;
    let cancelled = false;
    void detectDeploymentSource(window.location.href).then(result => {
      if (!cancelled) setSource(result);
    });
    return () => { cancelled = true; };
  }, [accepted]);

  return {
    source,
    blocked: !accepted && source !== 'official',
    accept: () => {
      acceptDeploymentNotice();
      setAccepted(true);
    },
  };
}
