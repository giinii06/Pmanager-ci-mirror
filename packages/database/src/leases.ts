/**
 * Renews a lease to the duration it was granted. Every writer of a lease row sets
 * `lease_expires_at` and `updated_at` in the same statement, so their difference is
 * the duration the consumer asked for. Binds two `now` parameters, and they must be
 * the statement's first two.
 */
export const RENEW_LEASE = 'lease_expires_at = ? + (lease_expires_at - updated_at), updated_at = ?'

/** Guards a renewal to a lease that has not expired. Binds one `now`, after the ids. */
export const LEASE_IS_LIVE = 'lease_expires_at >= ?'
