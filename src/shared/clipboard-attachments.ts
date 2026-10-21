/**
 * Largest clipboard item (screenshot, copied browser image) accepted for
 * paste-to-attach. Files copied from Finder/Explorer have a real path and are
 * copied on disk like drag-and-drop, so this limit does not apply to them.
 */
export const MAX_PASTED_ATTACHMENT_BYTES = 50 * 1024 * 1024
