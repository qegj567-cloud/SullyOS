import React, { useEffect, useState } from 'react';

/** Local feedback avoids rerendering the whole OS context for each saved field. */
export default function ApiSaveFeedback({ revision }: { revision: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!revision) { setVisible(false); return; }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 1400);
    return () => clearTimeout(timer);
  }, [revision]);
  return visible ? <div role="status" className="pointer-events-none fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] whitespace-nowrap rounded-full bg-slate-800 px-4 py-2 text-sm font-medium text-white shadow-lg">修改成功！</div> : null;
}
