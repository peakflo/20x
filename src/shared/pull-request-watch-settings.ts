/** Settings keys for pull request watching. Shared by the main process and the renderer. */

/** Global switch for watching pull requests. Absent means enabled. */
export const PR_WATCH_ENABLED_SETTING = 'pr_watch.enabled'

/** Optional "ready to merge" notice. Absent means enabled. */
export const PR_WATCH_READY_SETTING = 'pr_watch.notify_ready'
