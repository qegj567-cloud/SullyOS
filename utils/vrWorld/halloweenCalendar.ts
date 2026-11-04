import { getLocalDateKey } from '../localDate';

// The festival follows the user's calendar, not any character's time zone.
export const isKanataHalloween = (day = getLocalDateKey(new Date())) => day >= '2026-10-29' && day <= '2026-10-31';
export const isHalloweenFishDay = (at: number) => isKanataHalloween(getLocalDateKey(new Date(at)));
