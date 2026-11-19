import { useEffect, useState } from 'react';

/** Keep a visible schedule's current slot in step with the wall clock. */
export function useTickingNow(fixed?: Date): Date {
    const [now, setNow] = useState(() => fixed || new Date());
    useEffect(() => {
        if (fixed) return;
        const timer = window.setInterval(() => setNow(new Date()), 30_000);
        return () => window.clearInterval(timer);
    }, [fixed]);
    return fixed || now;
}
