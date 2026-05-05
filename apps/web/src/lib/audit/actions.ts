/**
 * Canonical event taxonomy for the audit log.
 *
 * Every `action` string written to `audit_log.action` MUST come from
 * this catalog. The writer (`writer.ts`) validates the field against
 * this union at runtime; the `AuditAction` type gives compile-time
 * safety at call sites.
 *
 * Naming convention: `<domain>.<entity>.<verb>`. Verb tense is past
 * for completed actions (`created`, `revoked`) and present for state
 * transitions that are still in flight (`delivering`, `investigating`).
 *
 * Rules for adding a new action:
 *   1. Add the string to the appropriate domain block below, sorted
 *      alphabetically within that block.
 *   2. Update `tests/audit/actions.test.ts` to exercise it.
 *   3. Write a redaction rule in `redact.ts` if the meta payload
 *      carries any PII (email, phone, DOB, document hash, etc.).
 *   4. If the action requires a new `target_kind`, first extend the
 *      `audit_target_kind` enum in `src/lib/db/schema/enums.ts` and
 *      generate a migration — the enum is a Postgres type.
 *
 * Removing an action is a breaking change to the compliance export
 * and requires a migration that backfills the old rows into a new
 * `legacy.*` action or drops them outright with a deletion marker.
 */

export const AUDIT_ACTIONS = {
  // ---------- Firm lifecycle ----------
  'firm.created': 'firm.created',
  'firm.deleted': 'firm.deleted',
  'firm.tier_changed': 'firm.tier_changed',
  'firm.updated': 'firm.updated',
  'firm.user_invited': 'firm.user_invited',
  'firm.user_accepted': 'firm.user_accepted',
  'firm.user_invite_expired': 'firm.user_invite_expired',
  'firm.user_role_changed': 'firm.user_role_changed',
  'firm.user_removed': 'firm.user_removed',
  'firm.user_unlocked': 'firm.user_unlocked',
  'firm.restored': 'firm.restored',

  // ---------- Firm users ----------
  'firm_user.accepted_invite': 'firm_user.accepted_invite',
  'firm_user.invited': 'firm_user.invited',
  'firm_user.login.failed': 'firm_user.login.failed',
  'firm_user.login.success': 'firm_user.login.success',
  // F-A1-J6-001 — Turnstile (bot-gate) failure on the firm login route.
  // OWASP ASVS V8.6.4 requires bot-detection failures to be logged so a
  // distributed credential-stuffing burst leaves a forensic trail even
  // when the underlying password attempt never reaches the auth path.
  // Auto-idempotent: emitted once per request before the 403, no DB
  // state to race against.
  'firm_user.login.turnstile_failed': 'firm_user.login.turnstile_failed',
  'firm_user.logout': 'firm_user.logout',
  'firm_user.password_changed': 'firm_user.password_changed',
  'firm_user.password_reset_requested': 'firm_user.password_reset_requested',
  'firm_user.password_reset_completed': 'firm_user.password_reset_completed',
  'firm_user.removed': 'firm_user.removed',
  'firm_user.role_changed': 'firm_user.role_changed',
  'firm_user.totp_disabled': 'firm_user.totp_disabled',
  'firm_user.totp_enabled': 'firm_user.totp_enabled',
  'firm_user.recovery_codes_generated': 'firm_user.recovery_codes_generated',
  'firm_user.recovery_code_used': 'firm_user.recovery_code_used',
  'firm_user.recovery_codes_regenerated': 'firm_user.recovery_codes_regenerated',
  // Refresh-token rotation success. Written by `/api/internal/auth/refresh`
  // on every successful CAS update. Mirror of `customer.session.created`
  // (which doubles as customer refresh audit via `meta.action='refresh'`);
  // firm side gets a dedicated verb so queries filtering on `actor_kind =
  // 'firm_user'` can project refresh events without a meta discriminator.
  'firm_user.session.refreshed': 'firm_user.session.refreshed',
  // OWASP ASVS V3.5.5 token-family revoke audit. Written inline at the
  // refresh route stale-replay branch (post-grace `previous_refresh_token_hash`
  // match) inside the same tx that flips `revoked_at`. Auto-idempotent:
  // a 2nd replay finds `revoked_at IS NOT NULL` at the early gate and
  // never re-enters the stale-replay branch — audit row written once
  // per family-compromise event.
  'firm_user.session.reuse_detected': 'firm_user.session.reuse_detected',

  // ---------- Admin users ----------
  'admin_user.created': 'admin_user.created',
  'admin_user.deleted': 'admin_user.deleted',
  'admin_user.impersonation_ended': 'admin_user.impersonation_ended',
  'admin_user.impersonation_started': 'admin_user.impersonation_started',
  'admin_user.login.failed': 'admin_user.login.failed',
  'admin_user.login.success': 'admin_user.login.success',
  // F-A1-J6-001 — Turnstile (bot-gate) failure on the admin login route.
  // Mirrors `firm_user.login.turnstile_failed`; admin is the highest
  // privilege audience, so a bot-gate breach attempt MUST surface even
  // when no credentials are submitted. See OWASP ASVS V8.6.4.
  'admin_user.login.turnstile_failed': 'admin_user.login.turnstile_failed',
  'admin_user.password_changed': 'admin_user.password_changed',
  'admin_user.role_changed': 'admin_user.role_changed',
  // Admin self-service TOTP management — mirrors the firm_user.*
  // naming so audit queries that span audiences can project on the
  // common suffix (`.totp_enabled`, `.totp_disabled`,
  // `.recovery_codes_regenerated`).
  'admin_user.totp_disabled': 'admin_user.totp_disabled',
  'admin_user.totp_enabled': 'admin_user.totp_enabled',
  'admin_user.recovery_codes_regenerated': 'admin_user.recovery_codes_regenerated',
  // Admin refresh-token rotation success — firm eşleniği
  // `firm_user.session.refreshed`. Admin en yüksek yetki audience'ı,
  // refresh'lerin audit trail'de eksiksiz durması compliance için kritik.
  'admin_user.session.refreshed': 'admin_user.session.refreshed',
  // OWASP ASVS V3.5.5 token-family revoke audit (admin parity with
  // firm_user.session.reuse_detected). Auto-idempotent via existing
  // refresh route revoked_at gate — see firm comment above.
  'admin_user.session.reuse_detected': 'admin_user.session.reuse_detected',
  // AUD-X-THREAT-002: hassas admin read'leri de audit'e yazılıyor.
  // Insider threat + GDPR Art 30 / SOC 2 CC6.8 için: admin'in customer
  // PII okuması, firma detail görmesi, ticket okuması artık iz
  // bırakıyor. Target = okunan kaynağın UUID'si; actor = admin.
  'admin_user.customer_viewed': 'admin_user.customer_viewed',
  'admin_user.firm_viewed': 'admin_user.firm_viewed',
  'admin_user.ticket_viewed': 'admin_user.ticket_viewed',

  // ---------- API keys ----------
  'api_key.auth.failed': 'api_key.auth.failed',
  'api_key.issued': 'api_key.issued',
  'api_key.last_used_updated': 'api_key.last_used_updated',
  'api_key.playground_used': 'api_key.playground_used',
  'api_key.revoked': 'api_key.revoked',
  'api_key.rotated': 'api_key.rotated',

  // ---------- Webhook endpoints (dashboard-initiated CRUD) ----------
  'webhook.endpoint_created': 'webhook.endpoint_created',
  'webhook.endpoint_updated': 'webhook.endpoint_updated',
  'webhook.endpoint_deleted': 'webhook.endpoint_deleted',
  'webhook.endpoint_tested': 'webhook.endpoint_tested',

  // ---------- OAuth clients ----------
  'oauth_client.created': 'oauth_client.created',
  'oauth_client.updated': 'oauth_client.updated',
  'oauth_client.secret_rotated': 'oauth_client.secret_rotated',
  'oauth_client.revoked': 'oauth_client.revoked',

  // ---------- OAuth consents ----------
  'oauth_consent.granted': 'oauth_consent.granted',
  'oauth_consent.revoked': 'oauth_consent.revoked',

  // ---------- OAuth runtime security alarms ----------
  // Emitted when the /token handler detects a second exchange
  // attempt against an authorization code that was already burned.
  // RFC 9700 §2.1.1 — invalidates every token minted from that code
  // and is an automatic tripped alarm: triage immediately.
  'oauth.code_reuse_detected': 'oauth.code_reuse_detected',
  // Fired when /token trips the 5-wrong-secret lockout on an OAuth
  // client. Paired with a 15-minute `secret_locked_until` on the
  // client row; operators should check the audit meta for the
  // offender's IP + attempt count.
  'oauth.client_secret_locked': 'oauth.client_secret_locked',
  // Fired the first time a freshly-issued access token is presented
  // to /userinfo. Gives the SOC a canonical "token went live" signal
  // per consent without the flood that "audit every userinfo call"
  // would produce — subsequent calls only bump `last_used_at`.
  'oauth.userinfo_first_use': 'oauth.userinfo_first_use',

  // ---------- KYC reconciler (drift sweep) ----------
  // Sprint 3 — periodic worker that scans customers with a
  // `customer.kyc_started` audit but no completion event + no active
  // credential row, fetches the live Didit decision, and re-routes
  // through the same pipeline path the webhook would have taken.
  // Reconciler decisions are auditable so a SOC operator can replay a
  // drift incident from the audit log alone. See
  // `.claude/KYC-RECONCILER-WORKER.md` for principles + edge cases.
  'kyc_reconciler.drift_detected': 'kyc_reconciler.drift_detected',
  'kyc_reconciler.drift_resolved': 'kyc_reconciler.drift_resolved',
  'kyc_reconciler.skipped_revoked_customer': 'kyc_reconciler.skipped_revoked_customer',
  'kyc_reconciler.phase_address_missing_identity_prereq': 'kyc_reconciler.phase_address_missing_identity_prereq',
  // Reverse-drift case: customer.kyc_level was reset to baseline (kyc_0)
  // or `revoked_at` was stamped, but one or more `kyc_sessions` rows were
  // left in a non-terminal state by an incomplete mutation path. The
  // reconciler's reverse-drift pass closes the orphaned sessions through
  // the canonical `revokeActiveKycSessions` helper. See
  // `kyc-reconciler-worker.ts::reconcileReverseDriftCustomer`.
  'kyc_reconciler.reverse_drift_resolved': 'kyc_reconciler.reverse_drift_resolved',
  // Stuck-mint case (Sprint 9 Faz 1.5): the credential pipeline ran
  // (or was enqueued) but `kyc_credentials_meta.status='pending'`
  // sat past `STUCK_MINT_THRESHOLD_MS` — pg-boss either dead-lettered
  // the job or the worker crashed mid-mint. The reconciler's third
  // pass detects these rows and re-enqueues the credential pipeline;
  // the pipeline's idempotency layers (singleton key, Phase 1
  // pre-check, partial unique index, chain commandId) absorb any
  // race with a late-arriving original job.
  'kyc_reconciler.stuck_mint_detected': 'kyc_reconciler.stuck_mint_detected',
  'kyc_reconciler.stuck_mint_resolved': 'kyc_reconciler.stuck_mint_resolved',

  // Stuck NFT-mint pass — companion of `stuck_mint_*` for the
  // user-triggered NFT mint. Detects credentials with the cred-mint
  // already on chain but `nftContractId` still NULL past the grace
  // window, then re-fetches the on-chain artefact (chain ACS by
  // boundCredentialId) and rehydrates the row. Closes the gap when
  // the mint endpoint crashes mid-handler — deterministic commandId
  // + chain dedup mean the chain has the NFT but the DB never got
  // the cross-reference.
  'kyc_reconciler.stuck_nft_mint_detected': 'kyc_reconciler.stuck_nft_mint_detected',
  'kyc_reconciler.stuck_nft_mint_resolved': 'kyc_reconciler.stuck_nft_mint_resolved',

  // ---------- KYC sessions ----------
  'kyc_session.cancelled': 'kyc_session.cancelled',
  'kyc_session.created': 'kyc_session.created',
  'kyc_session.decision_received': 'kyc_session.decision_received',
  'kyc_session.expired': 'kyc_session.expired',
  'kyc_session.identity_approved': 'kyc_session.identity_approved',
  'kyc_session.identity_rejected': 'kyc_session.identity_rejected',
  'kyc_session.started': 'kyc_session.started',
  'kyc_session.webhook_received': 'kyc_session.webhook_received',
  // Fired when the Didit webhook payload passes HMAC verification
  // but carries a `status` value the handler does not know how to
  // map (e.g. Didit shipped a new status value we have not wired
  // through `statusMap`). The payload is persisted to the session
  // row unchanged for manual triage; the session's logical status
  // is left untouched so re-delivery from the real upstream event
  // can still advance it. Appears as an actionable row in the SOC
  // dashboard.
  'kyc_session.webhook_unknown_status': 'kyc_session.webhook_unknown_status',

  // ---------- Credentials ----------
  'credential.chain_error': 'credential.chain_error',
  'credential.disclosed': 'credential.disclosed',
  'credential.issued': 'credential.issued',
  // Sprint 5 — B2B mint completion. Distinct from the customer-flow
  // `credential.issued` so SOC queries / firm dashboards can filter
  // self-service vs firm-issued credentials independently. Same row
  // shape (target = userRef on the issuing firm, meta carries firmId +
  // contractId), only the action verb differs. The `_firm_issued`
  // suffix avoids the digit `2` that would fail the audit-action regex
  // `/^[a-z_]+(\.[a-z_]+){1,3}$/`.
  'credential.firm_issued': 'credential.firm_issued',
  'credential.revoked': 'credential.revoked',
  'credential.verified': 'credential.verified',
  // Sprint 6 reuse-path — emitted when a NEW firm gains visibility on
  // an EXISTING credential via the face-match reuse branch (scenarios
  // 3 + 4 in the Sprint 6 plan). The credential is not re-minted; the
  // new firm just gets a `credential.created` webhook pointing at the
  // pre-existing contract. The audit row records the disclosure so
  // legal/compliance can prove the user consented (the consent gate
  // runs upstream via the existing OAuth-grant flow). Meta:
  // `{ credentialId, sourceFirmId, disclosedToFirmId, faceHash }`.
  'credential.firm_disclosed': 'credential.firm_disclosed',
  // Sprint 6 reuse-path — emitted when an EXISTING B2B-issued
  // credential is bound to a NEW customer-side account via the
  // face-match reuse branch (scenario 4: B2B X + customer Y self-
  // signup). The credential's `userRef` flips from the B2B userRef
  // to the new customer's id; the existing firm keeps its grant.
  // Meta: `{ credentialId, previousUserRef, customerId, faceHash }`.
  'credential.customer_bound': 'credential.customer_bound',

  // ---------- Webhook endpoints ----------
  'webhook_endpoint.created': 'webhook_endpoint.created',
  'webhook_endpoint.deleted': 'webhook_endpoint.deleted',
  'webhook_endpoint.disabled': 'webhook_endpoint.disabled',
  'webhook_endpoint.enabled': 'webhook_endpoint.enabled',
  'webhook_endpoint.secret_rotated': 'webhook_endpoint.secret_rotated',
  'webhook_endpoint.updated': 'webhook_endpoint.updated',

  // ---------- Webhook deliveries ----------
  'webhook_delivery.dead_lettered': 'webhook_delivery.dead_lettered',
  'webhook_delivery.delivered': 'webhook_delivery.delivered',
  'webhook_delivery.failed': 'webhook_delivery.failed',
  'webhook_delivery.retried': 'webhook_delivery.retried',
  'webhook_delivery.scheduled': 'webhook_delivery.scheduled',

  // ---------- Rate limit / quota ----------
  'ratelimit.quota_exceeded': 'ratelimit.quota_exceeded',
  'ratelimit.rate_limited': 'ratelimit.rate_limited',

  // ---------- Status / incidents ----------
  'incident.opened': 'incident.opened',
  'incident.resolved': 'incident.resolved',
  'incident.updated': 'incident.updated',
  'status_component.state_changed': 'status_component.state_changed',

  // ---------- Compliance / GDPR ----------
  'compliance.data_export_requested': 'compliance.data_export_requested',
  'compliance.data_exported': 'compliance.data_exported',
  'compliance.erasure_requested': 'compliance.erasure_requested',
  'compliance.meta_redacted': 'compliance.meta_redacted',

  // ---------- Customer lifecycle ----------
  'customer.registered': 'customer.registered',
  // F-A4-J3-001 — emitted by the register handler when the submitted
  // email is already in use (created branch's `existing` short-circuit)
  // OR when the address sits on the disposable-domain blacklist. The
  // public-facing 200 stays opaque to defeat enumeration, but the
  // forensic trail logs the attempt with `meta.outcome ∈ {existing,
  // blacklisted}` so SOC can spot credential-recon scans against the
  // register endpoint. Hashed identifier only — never the raw email.
  'customer.registration_attempt_existing': 'customer.registration_attempt_existing',
  'customer.email_verified': 'customer.email_verified',
  'customer.login.success': 'customer.login.success',
  'customer.login.failed': 'customer.login.failed',
  // F-A1-J6-001 — Turnstile (bot-gate) failure on the customer login,
  // register, resend-verification or forgot-password routes. Single
  // action key for all four customer routes; `meta.endpoint` carries
  // the discriminator so SOC dashboards can group by route without a
  // schema split. See OWASP ASVS V8.6.4 + sibling firm/admin variants.
  'customer.login.turnstile_failed': 'customer.login.turnstile_failed',
  'customer.logout': 'customer.logout',
  'customer.email_added': 'customer.email_added',
  'customer.password_changed': 'customer.password_changed',
  'customer.password_set': 'customer.password_set',
  'customer.password_reset_requested': 'customer.password_reset_requested',
  'customer.password_reset_completed': 'customer.password_reset_completed',
  'customer.profile_updated': 'customer.profile_updated',
  'customer.reauth.failed': 'customer.reauth.failed',
  'customer.reauth.rate_limited': 'customer.reauth.rate_limited',
  'customer.reauth.success': 'customer.reauth.success',
  'customer.suspended': 'customer.suspended',
  'customer.activated': 'customer.activated',
  'customer.locked': 'customer.locked',
  'customer.unlocked': 'customer.unlocked',
  'customer.banned': 'customer.banned',
  'customer.unbanned': 'customer.unbanned',
  'customer.fraud_detected': 'customer.fraud_detected',
  'customer.session.created': 'customer.session.created',
  'customer.session.revoked': 'customer.session.revoked',
  'customer.session.revoked_all': 'customer.session.revoked_all',
  // OWASP ASVS V3.5.5 token-family revoke audit (customer parity with
  // firm_user.session.reuse_detected). Auto-idempotent via existing
  // refresh route revoked_at gate at customer/auth/refresh/route.ts:172
  // — 2nd replay exits before re-entering the stale-replay branch.
  'customer.session.reuse_detected': 'customer.session.reuse_detected',

  // ---------- Customer OAuth / wallet ----------
  // Legacy action names (kept for log-pipeline compatibility):
  'customer.google_linked': 'customer.google_linked',
  'customer.google_login': 'customer.google_login',
  'customer.google_registered': 'customer.google_registered',
  'customer.google_unlinked': 'customer.google_unlinked',
  'customer.oauth_failed': 'customer.oauth_failed',
  // F-A2-I1-001 (Page 2 closure) — six canonical OAuth events
  // emitted via `lib/customer/audit-oauth.ts`. The legacy names
  // above stay registered so the brand-new-user (`customer.google_
  // registered`) path keeps its distinct journey marker.
  'customer.login.oauth.success': 'customer.login.oauth.success',
  'customer.login.oauth.failed': 'customer.login.oauth.failed',
  'customer.login.oauth.account_linked': 'customer.login.oauth.account_linked',
  'customer.login.oauth.status_promoted': 'customer.login.oauth.status_promoted',
  'customer.login.oauth.sub_collision': 'customer.login.oauth.sub_collision',
  'customer.login.oauth.replay_blocked': 'customer.login.oauth.replay_blocked',
  'customer.wallet_linked': 'customer.wallet_linked',
  'customer.wallet_unlinked': 'customer.wallet_unlinked',
  'customer.wallet_login': 'customer.wallet_login',
  'customer.wallet_login_failed': 'customer.wallet_login_failed',
  'customer.wallet_registered': 'customer.wallet_registered',

  // ---------- Customer profile ----------
  'customer.avatar_removed': 'customer.avatar_removed',
  'customer.email_change_initiated': 'customer.email_change_initiated',
  'customer.email_changed': 'customer.email_changed',
  'customer.avatar_updated': 'customer.avatar_updated',
  'customer.notification_prefs_updated': 'customer.notification_prefs_updated',
  'customer.onboarding_dismissed': 'customer.onboarding_dismissed',
  'customer.phone_updated': 'customer.phone_updated',

  // ---------- Customer KYC ----------
  'customer.credential_issued': 'customer.credential_issued',
  'customer.credential_superseded': 'customer.credential_superseded',
  'customer.credential_upgraded': 'customer.credential_upgraded',
  'customer.kyc_completed': 'customer.kyc_completed',
  'customer.kyc_expired': 'customer.kyc_expired',
  'customer.kyc_failed': 'customer.kyc_failed',
  'customer.kyc_in_review': 'customer.kyc_in_review',
  'customer.kyc_reset': 'customer.kyc_reset',
  'customer.kyc_revoked_by_didit_user': 'customer.kyc_revoked_by_didit_user',
  'customer.kyc_resubmission_requested': 'customer.kyc_resubmission_requested',
  'customer.kyc_started': 'customer.kyc_started',
  'customer.nft_minted': 'customer.nft_minted',

  // ---------- Email ----------
  'email.verification_sent': 'email.verification_sent',
  'email.password_reset_sent': 'email.password_reset_sent',
  'email.send_failed': 'email.send_failed',

  // ---------- RBAC ----------
  'role.created': 'role.created',
  'role.updated': 'role.updated',
  'role.deleted': 'role.deleted',
  'role.permission_granted': 'role.permission_granted',
  'role.permission_revoked': 'role.permission_revoked',
  'role.assigned': 'role.assigned',
  'role.unassigned': 'role.unassigned',

  // ---------- Blacklist ----------
  'blacklist.added': 'blacklist.added',
  'blacklist.removed': 'blacklist.removed',

  // ---------- Fraud cascade (Sprint 6 face-match) ----------
  // `face_match_blocked` — Didit's face_search 1:N hit pointed at a
  // DIFFERENT clean Crivacy customer; the current attempt is rejected
  // with the masked-email toast (`a...d@***.com`). No bans cascade.
  // Meta: `{ matchedCustomerId, matchedFirmId, currentCustomerId,
  // diditSessionId, riskCode, ipHash }`.
  'fraud.face_match_blocked': 'fraud.face_match_blocked',
  // `cascade_banned` — Didit's face_search 1:N hit pointed at a banned
  // account OR Didit ran a fraud signal (spoofing / replay /
  // tampering). The current customer is auto-banned via the cascade
  // path and any active credentials they had are revoked. Meta:
  // `{ reasonCode, matchedCustomerIds, faceHash, diditSessionId }`.
  'fraud.cascade_banned': 'fraud.cascade_banned',
  // `repeat_evader_detected` — pre-Didit IP-abuse counter passed the
  // 3-strike threshold within the active window; the next start-
  // session call from this IP is rejected with HTTP 503 BEFORE going
  // to Didit. Meta: `{ ipHash, count, threshold, ttlDays }`.
  'fraud.repeat_evader_detected': 'fraud.repeat_evader_detected',
  // `kyc_decline_strike` — every webhook / pull-fallback / reconciler
  // decline detection bumps `customers.consecutive_kyc_declines` by 1
  // and writes this row. Meta: `{ surface, kycSessionId, count,
  // threshold, thresholdCrossed }`.
  'fraud.kyc_decline_strike': 'fraud.kyc_decline_strike',
  // `kyc_decline_reset` — the credential-pipeline-worker cleared the
  // counter inside the mint TX after a successful approval. Only
  // emitted when the prior count was non-zero. Meta:
  // `{ kycSessionId, previousCount }`.
  'fraud.kyc_decline_reset': 'fraud.kyc_decline_reset',
  // `kyc_decline_locked` — pre-Didit per-customer gate fired: the
  // customer's `consecutive_kyc_declines` is at/above threshold AND
  // their `last_decline_at` is inside the cooldown window, so the
  // start-* call is rejected with HTTP 429. Meta: `{ surface, count,
  // threshold, cooldownEndsAt }`.
  'fraud.kyc_decline_locked': 'fraud.kyc_decline_locked',

  // ---------- Notifications ----------
  'notification.created': 'notification.created',

  // ---------- Tickets ----------
  'ticket.assigned': 'ticket.assigned',
  'ticket.assignee_transferred': 'ticket.assignee_transferred',
  'ticket.attachment_uploaded': 'ticket.attachment_uploaded',
  'ticket.auto_assigned': 'ticket.auto_assigned',
  'ticket.category_admin_added': 'ticket.category_admin_added',
  'ticket.category_admin_removed': 'ticket.category_admin_removed',
  'ticket.category_created': 'ticket.category_created',
  'ticket.category_deactivated': 'ticket.category_deactivated',
  'ticket.category_deleted': 'ticket.category_deleted',
  'ticket.category_updated': 'ticket.category_updated',
  'ticket.closed': 'ticket.closed',
  'ticket.created': 'ticket.created',
  'ticket.invite_expired': 'ticket.invite_expired',
  'ticket.invite_rescinded': 'ticket.invite_rescinded',
  'ticket.mention_created': 'ticket.mention_created',
  'ticket.mention_revoked': 'ticket.mention_revoked',
  'ticket.message_added': 'ticket.message_added',
  'ticket.message_edited': 'ticket.message_edited',
  'ticket.participant_accepted': 'ticket.participant_accepted',
  'ticket.participant_declined': 'ticket.participant_declined',
  'ticket.participant_invited': 'ticket.participant_invited',
  'ticket.participant_joined': 'ticket.participant_joined',
  'ticket.participant_left': 'ticket.participant_left',
  'ticket.participant_muted': 'ticket.participant_muted',
  'ticket.participant_removed': 'ticket.participant_removed',
  'ticket.participant_unmuted': 'ticket.participant_unmuted',
  'ticket.resolved': 'ticket.resolved',
  'ticket.status_changed': 'ticket.status_changed',
  'ticket.taken_over': 'ticket.taken_over',
  'ticket.unassigned': 'ticket.unassigned',

  // ---------- System (no user) ----------
  'system.backup.completed': 'system.backup.completed',
  'system.backup.started': 'system.backup.started',
  'system.backup.verified': 'system.backup.verified',
  'system.migration.applied': 'system.migration.applied',
  'system.worker.started': 'system.worker.started',
  'system.worker.stopped': 'system.worker.stopped',

  // ---------- Access control ----------
  // Fired by `dashboardRoute` / `adminRoute` when the middleware
  // rejects a caller for missing a declared permission. Meta carries
  // `{ permission, path, method }` so incident response can trace
  // which code the caller wanted and which URL they attempted.
  'access.permission_denied': 'access.permission_denied',

  // ---------- Auth rate limiting (window-edge audit) ----------
  // F-A1-J5-001 — fired by `enforceAuthRateLimit` exactly once per
  // window-edge crossing (the request that flips `attempts` from
  // `policy.max` to `policy.max + 1`). Subsequent in-window denials
  // do NOT re-emit; this gives SOC a single forensic row per burst
  // without log floods. Single action key for every auth-flow rate
  // limit policy (login / register / resend-verification / forgot-
  // password / reset / refresh) — `meta.endpoint`, `meta.policy`,
  // `meta.attempts`, `meta.max`, `meta.retryAfterSeconds` carry the
  // forensic discriminator. See NIST SP 800-92 §3.5 + SOC2 SO-7.
  'auth.rate_limit_fired': 'auth.rate_limit_fired',
} as const;

/**
 * Strong union of every legal `action` string. Call sites get full
 * autocomplete and compile-time exhaustiveness. The value space is
 * closed; `writer.ts` rejects anything else as `invalid_action`.
 */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * All action strings as a readonly array, in declaration order. Used
 * by the runtime validator and by the taxonomy test that pins the
 * full set against an explicit snapshot.
 */
export const ALL_AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze(
  Object.values(AUDIT_ACTIONS),
);

/**
 * Runtime membership test for untrusted input. The route layer calls
 * this before handing a string to `writer.ts` so we can return a 400
 * instead of letting the writer throw a 500.
 */
export function isAuditAction(value: unknown): value is AuditAction {
  if (typeof value !== 'string') {
    return false;
  }
  return (ALL_AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Lookup the domain prefix of an action (`firm`, `api_key`, ...).
 * Used by the redaction module to pick a domain-specific policy, and
 * by the query helpers to build a `LIKE 'firm.%'` filter.
 */
export function auditActionDomain(action: AuditAction): string {
  const dot = action.indexOf('.');
  return dot === -1 ? action : action.slice(0, dot);
}
