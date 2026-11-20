// Separate, origin-wide read markers. The existing sullyos_update_ prefix keeps
// announcements shared across user spaces; lsMirror preserves them on recovery.
export const AMSG_RECENT_UPDATE_KEY = 'sullyos_update_20261115_amsg2_seen';
export const SULLY_SUPPORT_NOTICE_KEY = 'sullyos_update_20261115_support_seen';
export const HELP_STICKERS_UPDATE_KEY = 'sullyos_update_20261119_help_stickers_seen';
