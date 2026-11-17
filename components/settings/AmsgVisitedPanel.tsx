import React, { useEffect, useState } from 'react';

/** Mount on first visit, then retain local form state while the parent hides it. */
export default function AmsgVisitedPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  return active || visited ? <>{children}</> : null;
}
