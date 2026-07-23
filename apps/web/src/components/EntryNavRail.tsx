// Team-edition entry navigation rail (Lovart/Manus-style labeled column).
//
// Structure — faithfully ported from the design demo
// (origin/demo/workspace-team-features) but wired to the REAL workspace context
// (`GET /api/workspace/context`, shared via `useWorkspaceContext`), never the
// demo's hardcoded 琼羽 / Refly / 800 placeholders:
//
//   • Account section (top) — real `context.displayName` + an account menu
//     (settings / GitHub help / feature request / socials / sign out — theme and
//     language live in 设置·通用 only, matching #5517).
//     Falls back to the brand logo when there is no cloud identity
//     (context === null).
//   • Credits chip — real plan tier + balance when A's vela CLI billing summary
//     is available, with upgrade linking out to Vela Web.
//   • Search box (opens the ⌘K project search palette via `onOpenSearch`).
//   • 最近 (Recents) → home, Community → community.
//   • Team block (only when `context.workspaceType === 'team'`): an inline team
//     switcher + the team destinations. In-client views: drafts / all projects /
//     design systems / 扩展 (plugins). Member management lives in B's vela/web
//     console, so 成员 / 数据大盘 / Workspace 设置 link OUT to it (target=_blank),
//     derived from `context.workspaceSettingsUrl`.
//
// The gate is `workspaceType` + permissions, never the billing/provider axis — a
// personal_byok workspace still has full team features.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { coalescedGet } from '../lib/coalesced-get';
import type {
  WorkspaceActiveResponse,
  WorkspaceBillingSummary,
  WorkspaceCollabContext,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
} from '@open-design/contracts';
import { fetchVelaLoginStatus, velaLogout } from '../providers/daemon';
import { notifyAmrLoginStatusChanged } from './amrLoginPolling';
import { Icon } from './Icon';
import { GITHUB_STARS_FALLBACK_LABEL, formatStars, useGithubStars } from './useGithubStars';
import { PlanWordmark, planBadgeTierForLabel } from './PlanWordmark';
import { RemixIcon } from './RemixIcon';
import { InviteDialog } from './InviteDialog';
import { useI18n } from '../i18n';
import { useDismissOnOutsideInteraction } from '../hooks/useDismissOnOutsideInteraction';
import {
  notifyTeamProjectsChanged,
  notifyWorkspaceBillingRefresh,
  notifyWorkspaceContextRefresh,
} from '../collab/useWorkspaceContext';
import { resolvePlanLabelTier } from '../collab/team-plan';
import type { EntryHomeView } from '../router';

const REPO_URL = 'https://github.com/nexu-io/open-design';
const GITHUB_HELP_URL = `${REPO_URL}/issues/new`;
const GITHUB_FEATURE_URL = `${REPO_URL}/pulls`;
const DISCORD_URL = 'https://discord.gg/mHAjSMV6gz';
const X_URL = 'https://x.com/OpenDesignHQ';
const CONTACT_EMAIL_URL = 'mailto:support@open-design.ai';
const externalLinkProps = { target: '_blank', rel: 'noreferrer noopener' } as const;

// Last directory this shell successfully read. `coalescedGet` only collapses
// CONCURRENT reads, so without this every open of the switcher started from an
// empty list and showed a loading row before the same names reappeared. Kept at
// module scope so it survives the rail unmounting (returning from a project).
let cachedWorkspaceDirectory: WorkspaceDirectoryItem[] | null = null;

/** Test seam: clear the module-level directory cache between tests. */
export function resetWorkspaceDirectoryCache(): void {
  cachedWorkspaceDirectory = null;
}

// The rail's destination ids are the entry-shell home views (kept in sync with
// the router so `navigate({ kind: 'home', view })` type-checks for every item).
export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  /** Opens the project search palette (blurred modal over all projects). */
  onOpenSearch?: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Collapse the rail — called when the user dismisses it (topbar toggle). */
  onClose: () => void;
  /** The one shared workspace context; null → local (no cloud identity) state. */
  context: WorkspaceCollabContext | null;
  /** Real billing summary (A-lane, via the vela CLI 收口). Null → the credits
   *  chip falls back to the context plan-tier hint with no balance. */
  billing?: WorkspaceBillingSummary | null;
  /** Open the app settings dialog. */
  onOpenSettings?: () => void;
  /** Open the members / invite slot (B's InviteDialog). */
  onInvite?: () => void;
  /** Start the cloud sign-in / team flow from the local-state callout. */
  onSignInCloud?: () => void;
  /** Extra controls pinned to the bottom-left of the rail. */
  footerExtra?: ReactNode;
  /** Optional notice shown above the footer controls. */
  footerNotice?: ReactNode;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, tooltip, onClick, disabled, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{tooltip}</span>
    </button>
  );
}

// Team management (members, dashboard, settings) lives in B's vela/web console,
// not the local client. We link out to it, deriving the section path from the one
// workspace-settings URL the context carries. Best-effort: swap/append the section
// segment, falling back to the raw settings URL when the path can't be rewritten.
export function teamConsoleUrl(
  base: string,
  section: 'members' | 'dashboard' | 'settings' | 'billing' | 'upgrade' | 'create-team',
): string {
  // B's console routes: members live at /team, the (global) wallet backs the
  // billing entry. The settings URL the context carries includes the
  // ?workspaceId deep-link param; URL parsing preserves it, so the target page
  // opens on the SAME workspace this client is pinned to (B asks the user to
  // confirm if their account-level selection differs).
  //
  // `upgrade` lands on the team dashboard AND opens the plan-change dialog,
  // because sending someone to a billing page to hunt for the upgrade control
  // is a worse answer to "I want to upgrade". B already honors the deep link:
  // both `routes/workspace-settings.tsx` and `routes/team-dashboard.tsx` open
  // their checkout dialog when `billing=checkout` is present.
  const path =
    section === 'members' ? 'team'
    : section === 'billing' ? 'wallet'
    : section === 'upgrade' ? 'dashboard'
    : section === 'create-team' ? 'dashboard'
    : section;
  try {
    const url = new URL(base);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > 0 && segments[segments.length - 1] === 'settings') {
      segments[segments.length - 1] = path;
    } else {
      segments.push(path);
    }
    url.pathname = `/${segments.join('/')}`;
    if (section === 'upgrade') url.searchParams.set('billing', 'checkout');
    // recvq725Kx0rM4: `create-team` used to set `?workspace=create` on the
    // premise that B's dashboard honors it as a deep link into the
    // create-workspace dialog, the same way `billing=checkout` opens the
    // upgrade dialog. Checked against B's actual route source
    // (routes/team-dashboard.tsx, routes/workspace-settings.tsx): neither
    // reads a `workspace` search param at all — the dialog is opened by
    // clicking a sidebar button (`sidebar-actions.tsx`'s `openCreateWorkspace`),
    // pure client state with no URL hook. The stale param made this entry
    // look like "nothing happened" (dashboard loads, no dialog) rather than a
    // broken link, which is why it read as "路径丢失" instead of "先跳个页面
    // 自己找按钮". Land on the plain dashboard — no dead deep-link param —
    // until B exposes a real one to replace this comment and the omission.
    return url.toString();
  } catch {
    return base;
  }
}

/**
 * Map a raw vela plan id to a display label for the credits card.
 *
 * B's ids are namespaced by workspace kind and tier (`team_plus`, `team_max`,
 * `pro`, …). The card pairs this label with a PlanWordmark badge that already
 * carries the tier, so the label names the PLAN FAMILY (团队版 / 免费版 / …)
 * and never leaks a raw snake_case id — `team_plus` used to render verbatim
 * because only three exact ids were mapped.
 *
 * NOTE (parked 2026-07-20): membership is per workspace, so one account can
 * hold a personal 创作会员 tier AND a team tier at once. How the card should
 * present that (one family label, both badges, which one wins in a team) is
 * with the designer; see the ledger. Until then this keeps the pre-existing
 * single-label behavior.
 */
function formatBillingTier(tier: string, t: ReturnType<typeof useI18n>['t']): string {
  const normalized = tier.trim().toLowerCase();
  if (!normalized) return t('entry.billingTierFree');
  if (normalized === 'team' || normalized.startsWith('team_') || normalized.startsWith('team-')) {
    return t('entry.billingTierTeam');
  }
  if (normalized === 'free') return t('entry.billingTierFree');
  if (normalized === 'pro' || normalized === 'plus' || normalized === 'max') {
    return t('entry.billingTierPro');
  }
  // Unknown id: title-case the segments rather than showing `some_new_tier`.
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  onOpenSearch,
  newProjectDisabled,
  open,
  onClose,
  context,
  billing,
  onOpenSettings,
  footerExtra,
  footerNotice,
}: Props) {
  const { t } = useI18n();
  const brandLabel = t('app.brand');
  const communityLabel = t('pluginsHome.title');
  // #5517 renamed the rail's first item from 最近 (Recents) to 首页 (Home) —
  // the key keeps its historical name, the VALUE now reads Home in every
  // locale (polish round 2, ref 1db2d00c2).
  const homeLabel = t('entry.navRecents');
  const isHome = view === 'home';

  const isTeam = Boolean(context) && context!.workspaceType === 'team';
  const permissions = context?.permissions;
  // Demo `canOwnWorkspace` → real owner-level view of workspace settings. Never
  // re-derive from role — the permission bits already fold role + lifecycle in.
  const canViewWorkspaceSettings = Boolean(permissions?.canViewWorkspaceSettings);
  const canInviteMembers = Boolean(permissions?.canInviteMembers);
  const workspaceSettingsUrl = context?.workspaceSettingsUrl?.trim() || null;

  // Account identity (real). No email field on the context → the head shows the
  // avatar + name only.
  const displayName = context?.displayName?.trim() || '';
  const accountName = displayName || brandLabel;
  const accountInitial = accountName.charAt(0).toUpperCase() || '·';

  // Credits chip: prefer the real billing summary (A-lane, via the vela CLI
  // 收口); fall back to the context plan-tier hint with no balance when billing
  // hasn't loaded / no session.
  // The plan id from either source goes through the same formatter — the
  // context hint is a raw id too (`team_plus`), and it used to reach the card
  // unformatted whenever billing reported an empty tier (which it does today).
  const rawTier = billing?.membershipTier?.trim() || context?.planId?.trim() || '';
  // The LABEL is a subscription question, never a workspace-kind one: B makes
  // every user-created workspace team-typed, so `isTeam` labelled brand-new
  // unpaid workspaces 团队版 (#146). `resolvePlanLabelTier` answers 'free' when
  // B positively reports an unsubscribed entitlement, and null when it simply
  // has not said — only the null case still falls back to the legacy hint, so
  // a paying member (whom B tells us nothing about) keeps their team label.
  const labelTier = resolvePlanLabelTier({ billing, context });
  const tierLabel = labelTier
    ? formatBillingTier(labelTier, t)
    : isTeam
      ? t('entry.billingTierTeam')
      : t('entry.billingTierFree');
  const creditsBalance = billing ? billing.totalAvailableCredits : null;
  // #5517: wordmark badge on the account row (replaces the chevron) and a
  // small twin inside the menu's billing card. Derive from the raw tier id
  // first so "team_plus" maps to the plus badge regardless of display label.
  // Feed the RAW id first: the display label is now a plan-family name
  // (团队版), which carries no tier word, so deriving the badge from it would
  // drop the PLUS/PRO/MAX distinction. `rawTier` already prefers billing over
  // the context hint and is empty only when neither reported one.
  const planTier = planBadgeTierForLabel(rawTier || tierLabel);

  const [accountOpen, setAccountOpen] = useState(false);
  const githubStars = useGithubStars();
  // Signed-in account email for the menu head (#5517 shows it under the
  // display name). The workspace context carries no email, so lazily read the
  // vela login-status projection the first time the menu opens — never on
  // mount, so shells without an open menu spend zero requests on it.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!accountOpen) return;
    // Refetch on EVERY open (the previous value stays visible while the read
    // is in flight, so there is no flicker). A fetch-once cache here went
    // stale the moment the user switched vela accounts mid-session — the menu
    // kept showing the first account's email (#102).
    let cancelled = false;
    void fetchVelaLoginStatus().then((status) => {
      if (!cancelled) setAccountEmail(status?.user?.email?.trim() || '');
    });
    return () => {
      cancelled = true;
    };
  }, [accountOpen]);
  // Hover-open for the account menu (#5517 interaction). The popover floats
  // above the trigger, so closing is delayed just long enough for the pointer
  // to cross the gap; re-entering the container (menu included — it's a DOM
  // child even though it renders above) cancels the pending close.
  const accountCloseTimer = useRef<number | null>(null);
  const cancelAccountClose = () => {
    if (accountCloseTimer.current !== null) {
      window.clearTimeout(accountCloseTimer.current);
      accountCloseTimer.current = null;
    }
  };
  const openAccountMenu = () => {
    cancelAccountClose();
    setAccountOpen(true);
  };
  const scheduleAccountClose = () => {
    cancelAccountClose();
    accountCloseTimer.current = window.setTimeout(() => setAccountOpen(false), 220);
  };
  useEffect(() => cancelAccountClose, []);
  // While open, track the pointer at the document level: anywhere outside the
  // account container arms the close timer, back inside disarms it. This is
  // deliberately NOT React onMouseLeave — leaving from inside the floating
  // menu does not reliably produce a synthetic leave on the container.
  const accountContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!accountOpen) return;
    const onDocPointerOver = (ev: PointerEvent) => {
      const container = accountContainerRef.current;
      if (!container) return;
      if (container.contains(ev.target as Node)) cancelAccountClose();
      else scheduleAccountClose();
    };
    document.addEventListener('pointerover', onDocPointerOver, true);
    return () => document.removeEventListener('pointerover', onDocPointerOver, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountOpen]);
  // Hover-out alone leaves the menu open for anyone who never hovers: a touch
  // user, or a click that lands somewhere else without the pointer crossing
  // this container. Press-outside closes it now rather than 220ms later, and
  // Escape gives the keyboard the same exit. Still a listener, not a backdrop,
  // so the pointerover tracking above keeps receiving its events.
  useDismissOnOutsideInteraction(accountOpen, accountContainerRef, () => {
    cancelAccountClose();
    setAccountOpen(false);
  });
  const [teamOpen, setTeamOpen] = useState(false);
  const [workspaceItems, setWorkspaceItems] = useState<WorkspaceDirectoryItem[]>(
    () => cachedWorkspaceDirectory ?? [],
  );
  const [workspaceDirectoryLoading, setWorkspaceDirectoryLoading] = useState(false);
  const [workspaceSwitchingId, setWorkspaceSwitchingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const billingUpgradeUrl =
    context?.billingRecovery?.recoveryUrl?.trim() ||
    (workspaceSettingsUrl ? teamConsoleUrl(workspaceSettingsUrl, 'upgrade') : null);
  // #62: the 积分 row links straight OUT to B's wallet page (usage detail lives
  // there) — no intermediate credits popover in the client, matching #5517.
  const billingWalletUrl = workspaceSettingsUrl
    ? teamConsoleUrl(workspaceSettingsUrl, 'billing')
    : null;
  // Product decision: plan selection / payment lives in Vela Web. The local
  // client opens that billing surface, then refreshes billing + context when
  // focus returns so direct web upgrades sync plan, credits, seats and gates.
  const canUpgrade = Boolean(billingUpgradeUrl && permissions?.canManageBilling);
  const currentWorkspaceItem = context
    ? workspaceItems.find((item) => item.workspaceId === context.workspaceId) ?? null
    : null;
  const workspaceName =
    currentWorkspaceItem?.workspaceName?.trim() ||
    context?.teamName?.trim() ||
    context?.teamId ||
    (context?.workspaceType === 'personal' ? 'Personal workspace' : '');
  const workspaceInitial = workspaceName.charAt(0).toUpperCase() || 'W';
  const visibleWorkspaceItems =
    workspaceItems.length > 0
      ? workspaceItems
      : context
        ? [{
            workspaceId: context.workspaceId,
            workspaceName,
            workspaceType: context.workspaceType,
            workspaceMemberId: context.workspaceMemberId,
            role: context.role,
            memberStatus: context.memberStatus,
            lifecycleState: context.lifecycleState,
          } satisfies WorkspaceDirectoryItem]
        : [];

  async function loadWorkspaceDirectory() {
    // Only show the loading row when there is nothing to show yet. With a warm
    // cache the list is already on screen and this read just revalidates it.
    if (cachedWorkspaceDirectory === null) setWorkspaceDirectoryLoading(true);
    try {
      const items = await coalescedGet('workspace-directory', async () => {
        const response = await fetch('/api/workspace/directory', { cache: 'no-store' });
        if (!response.ok) throw new Error(`directory ${response.status}`);
        const body = (await response.json()) as WorkspaceDirectoryResponse;
        return body.items ?? [];
      });
      cachedWorkspaceDirectory = items;
      setWorkspaceItems(items);
    } catch {
      // A failed revalidation must not blank a list the user is looking at —
      // keep the last known names and let the next open try again.
      if (cachedWorkspaceDirectory === null) setWorkspaceItems([]);
    } finally {
      setWorkspaceDirectoryLoading(false);
    }
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === context?.workspaceId || workspaceSwitchingId) return;
    setWorkspaceSwitchingId(workspaceId);
    try {
      const response = await fetch('/api/workspace/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as WorkspaceActiveResponse;
      setTeamOpen(false);
      notifyWorkspaceContextRefresh();
      notifyWorkspaceBillingRefresh();
      notifyTeamProjectsChanged();
      selectView('home');
    } catch {
      // Keep the menu open; the next open/focus refresh can retry the directory.
    } finally {
      setWorkspaceSwitchingId(null);
    }
  }

  function openBillingUpgrade() {
    if (!billingUpgradeUrl) return;
    window.open(billingUpgradeUrl, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => {
      notifyWorkspaceBillingRefresh();
      notifyWorkspaceContextRefresh();
    }, 3000);
  }

  const selectView = (next: EntryView) => {
    onViewChange(next);
  };

  // While collapsed the rail is visually hidden but its controls stay mounted;
  // mark it `inert` so they leave the tab order and pointer flow entirely.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  useEffect(() => {
    if (!teamOpen) return;
    void loadWorkspaceDirectory();
  }, [teamOpen]);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label={t('entry.primaryNavAria')}
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__panel">
      <div className="entry-nav-rail__group">
        {context ? (
          <div
            ref={accountContainerRef}
            className="entry-nav-rail__account"
            onMouseEnter={cancelAccountClose}
            onMouseLeave={scheduleAccountClose}
          >
            <button
              type="button"
              className="entry-nav-rail__account-trigger"
              onClick={() => setAccountOpen((v) => !v)}
              onMouseEnter={openAccountMenu}
              aria-expanded={accountOpen}
              data-testid="entry-nav-account"
            >
              <span className="entry-nav-rail__account-avatar" aria-hidden>{accountInitial}</span>
              <span className="entry-nav-rail__account-name">{accountName}</span>
              {/* #5517: the plan badge replaces the chevron when a tier is
                  known — the standalone credits chip row is gone; credits
                  live in the account menu's billing card. */}
              {planTier ? <PlanWordmark tier={planTier} height={17} /> : <Icon name="chevron-down" size={14} />}
            </button>
            {accountOpen ? (
              <>
                {/* No backdrop here (unlike the team menu): hover-open relies
                    on document-level pointerover to close, and a full-screen
                    backdrop would swallow those events and insta-close. */}
                <div className="entry-nav-rail__account-menu" role="menu">
                  <div className="entry-nav-rail__account-head">
                    <span className="entry-nav-rail__account-head-avatar" aria-hidden>{accountInitial}</span>
                    <span className="entry-nav-rail__account-head-name">{accountName}</span>
                    {accountEmail ? (
                      <span className="entry-nav-rail__account-head-email">{accountEmail}</span>
                    ) : null}
                  </div>
                  {/* #5517 billing card: plan (+badge) + 升级 CTA + credits row.
                      Credits are real billing data. The credits row links out
                      to B's wallet page. Product ruling (2026-07-22): we do
                      not have a separate "附加积分" (bonus/top-up credits)
                      concept to show — 积分 is the one number that matters. */}
                  {billing ? (
                    <div className="entry-nav-rail__menu-credits">
                      <div className="entry-nav-rail__menu-credits-head">
                        <span className="entry-nav-rail__menu-credits-plan">
                          {tierLabel}
                          {planTier ? <PlanWordmark tier={planTier} height={11} /> : null}
                        </span>
                        {canUpgrade ? (
                          <button
                            type="button"
                            className="entry-nav-rail__menu-credits-upgrade"
                            onClick={() => {
                              setAccountOpen(false);
                              openBillingUpgrade();
                            }}
                          >
                            {t('entry.creditsUpgrade')}
                          </button>
                        ) : null}
                      </div>
                      {/* #62 (product ruling): clicking 积分 jumps straight to
                          B's web wallet page for the usage detail — there is
                          NO intermediate credits popover in the client. */}
                      <button
                        type="button"
                        className="entry-nav-rail__menu-credits-row"
                        data-testid="entry-nav-credits-row"
                        onClick={() => {
                          setAccountOpen(false);
                          if (billingWalletUrl) {
                            window.open(billingWalletUrl, '_blank', 'noopener,noreferrer');
                          }
                        }}
                      >
                        <span className="entry-nav-rail__menu-credits-label">
                          <RemixIcon name="battery-charge-line" size={14} /> {t('entry.credits')}
                        </span>
                        <span className="entry-nav-rail__menu-credits-value">
                          {creditsBalance != null ? creditsBalance.toLocaleString('en-US') : '—'}
                          <Icon name="chevron-right" size={14} />
                        </span>
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="entry-nav-rail__menu-item"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      onOpenSettings?.();
                    }}
                  >
                    <Icon name="settings" size={15} /> {t('entry.accountSettings')}
                  </button>
                  {/* #5517's account menu goes 设置 → GitHub 帮助 → 功能建议 → 社交行,
                      with no theme row, no language submenu, and no divider in
                      between. Both controls still have a home in 设置·通用 (theme
                      segmented control + language picker), so dropping the
                      duplicates here costs no capability. */}
                  <a
                    className="entry-nav-rail__menu-item"
                    role="menuitem"
                    href={GITHUB_HELP_URL}
                    {...externalLinkProps}
                    onClick={() => setAccountOpen(false)}
                  >
                    <Icon name="comment" size={15} /> {t('entry.accountGithubHelp')}
                  </a>
                  <a
                    className="entry-nav-rail__menu-item"
                    role="menuitem"
                    href={GITHUB_FEATURE_URL}
                    {...externalLinkProps}
                    onClick={() => setAccountOpen(false)}
                  >
                    <Icon name="sparkles" size={15} /> {t('entry.accountFeatureRequest')}
                  </a>
                  {/* #5517: the GitHub/Discord/X/mail badges move off the rail
                      footer into a compact social row inside the account menu. */}
                  <div className="entry-nav-rail__menu-social">
                    <a
                      className="entry-nav-rail__menu-social-btn"
                      role="menuitem"
                      href={REPO_URL}
                      {...externalLinkProps}
                      aria-label={`GitHub · ${githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)} stars`}
                      title={`GitHub · ${githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)} stars`}
                      onClick={() => setAccountOpen(false)}
                    >
                      <Icon name="github-filled" size={15} />
                      <span className="entry-nav-rail__menu-social-count">
                        {githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)}
                      </span>
                    </a>
                    <a
                      className="entry-nav-rail__menu-social-btn"
                      role="menuitem"
                      href={DISCORD_URL}
                      {...externalLinkProps}
                      aria-label={t('entry.discordAria')}
                      title={t('entry.discordAria')}
                      onClick={() => setAccountOpen(false)}
                    >
                      <Icon name="discord" size={15} />
                    </a>
                    <a
                      className="entry-nav-rail__menu-social-btn"
                      role="menuitem"
                      href={X_URL}
                      {...externalLinkProps}
                      aria-label="@OpenDesignHQ"
                      title="@OpenDesignHQ"
                      onClick={() => setAccountOpen(false)}
                    >
                      <span className="entry-nav-rail__menu-x" aria-hidden>X</span>
                    </a>
                    <a
                      className="entry-nav-rail__menu-social-btn"
                      role="menuitem"
                      href={CONTACT_EMAIL_URL}
                      aria-label={t('entry.mailAria')}
                      title={t('entry.mailAria')}
                      onClick={() => setAccountOpen(false)}
                    >
                      <Icon name="mail" size={15} />
                    </a>
                  </div>
                  <div className="entry-nav-rail__menu-divider" />
                  <button
                    type="button"
                    className="entry-nav-rail__menu-item"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      // Real sign-out: clear the vela profile auth on the
                      // daemon, then nudge every workspace surface to re-read
                      // (the context read now resolves to null → the shell
                      // falls back to the signed-out local form).
                      void velaLogout().then(() => {
                        notifyAmrLoginStatusChanged();
                        notifyWorkspaceContextRefresh();
                        notifyWorkspaceBillingRefresh();
                        notifyTeamProjectsChanged();
                      });
                    }}
                  >
                    <Icon name="log-out" size={15} /> {t('entry.accountSignOut')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="entry-nav-rail__brand">
            <button
              type="button"
              className="entry-nav-rail__local-logo"
            onClick={() => selectView('home')}
            aria-label={brandLabel}
            data-testid="entry-nav-logo"
          >
            <span
              className="entry-nav-rail__logo-img od-brand-glyph"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="entry-nav-rail__collapse"
            onClick={onClose}
            aria-label={t('entry.navCollapse')}
            title={t('entry.navCollapse')}
            data-testid="entry-nav-collapse"
          >
            <Icon name="panel-left" size={20} />
          </button>
          </div>
        )}

        <button
          type="button"
          className="entry-nav-rail__search"
          onClick={() => onOpenSearch?.()}
          aria-label={t('common.search')}
          data-testid="entry-nav-search"
        >
          <Icon name="search" size={14} />
          <span className="entry-nav-rail__search-placeholder">{t('common.search')}</span>
          <span className="entry-nav-rail__search-kbd" aria-hidden>⌘K</span>
        </button>

        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          tooltip={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={16} />
        </NavButton>
        <NavButton
          active={view === 'community'}
          ariaLabel={communityLabel}
          tooltip="Community"
          onClick={() => selectView('community')}
          testId="entry-nav-community"
        >
          <Icon name="globe" size={16} />
        </NavButton>

        {context ? (
          <div className="entry-nav-rail__team-section">
            <div className="entry-nav-rail__team-wrap">
              <button
                type="button"
                className="entry-nav-rail__team"
                onClick={() => setTeamOpen((v) => !v)}
                aria-expanded={teamOpen}
                data-testid="workspace-switcher"
              >
                <span className="entry-nav-rail__team-avatar" aria-hidden>{workspaceInitial}</span>
                <span className="entry-nav-rail__team-name">{workspaceName}</span>
                <Icon name="chevron-down" size={14} />
              </button>
              {teamOpen ? (
                <>
                  <div className="entry-nav-rail__menu-backdrop" onClick={() => setTeamOpen(false)} />
                  <div className="entry-nav-rail__team-menu" role="menu">
                    {visibleWorkspaceItems.map((item) => {
                      const active = item.workspaceId === context.workspaceId;
                      const initial = item.workspaceName.trim().charAt(0).toUpperCase() || 'W';
                      return (
                        <button
                          key={item.workspaceId}
                          type="button"
                          className={`entry-nav-rail__menu-item${active ? ' is-current' : ''}`}
                          role="menuitem"
                          aria-current={active ? 'true' : undefined}
                          // Only the in-flight switch disables a row. Disabling the
                          // CURRENT one made the UA grey it out, so the selected
                          // workspace read as the inactive one and vice versa;
                          // `.is-current` (bold + accent ✓) is the selected signal.
                          disabled={workspaceSwitchingId === item.workspaceId}
                          onClick={() => {
                            void switchWorkspace(item.workspaceId);
                          }}
                        >
                          <span className="entry-nav-rail__team-avatar" aria-hidden>{initial}</span>
                          {/* #5517's switcher rows are avatar + full name + ✓ only.
                              The raw role word ate the name's width and truncated
                              it; the role is already on 设置·工作区. */}
                          <span className="entry-nav-rail__workspace-menu-name">{item.workspaceName}</span>
                          {active ? <Icon name="check" size={14} /> : null}
                        </button>
                      );
                    })}
                    {workspaceDirectoryLoading && visibleWorkspaceItems.length === 0 ? (
                      <div className="entry-nav-rail__menu-item is-muted" role="status">
                        {t('common.loading')}
                      </div>
                    ) : null}
                    <div className="entry-nav-rail__menu-divider" />
                    {canInviteMembers ? (
                      <button
                        type="button"
                        className="entry-nav-rail__menu-item"
                        role="menuitem"
                        onClick={() => {
                          setTeamOpen(false);
                          setInviteOpen(true);
                        }}
                      >
                        <Icon name="share" size={15} /> {t('workspaceSwitcher.invite')}
                      </button>
                    ) : null}
                    {/* Creating a workspace is a B console flow (its sidebar owns the
                        create dialog; there is no route or query param that opens it
                        directly), so this entry links OUT instead of doing local work.
                        With no console URL there is nowhere to send the user — render
                        nothing rather than a control that silently does nothing. */}
                    {workspaceSettingsUrl ? (
                      <a
                        className="entry-nav-rail__menu-item"
                        role="menuitem"
                        href={teamConsoleUrl(workspaceSettingsUrl, 'create-team')}
                        {...externalLinkProps}
                        data-testid="entry-nav-create-team"
                        onClick={() => setTeamOpen(false)}
                      >
                        <Icon name="plus" size={15} /> {t('workspaceSwitcher.createTeam')}
                      </a>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
            <NavButton
              active={view === 'drafts'}
              ariaLabel={t('entry.navDrafts')}
              tooltip={t('workspaceSwitcher.draftsTooltip')}
              onClick={() => selectView('drafts')}
              testId="entry-nav-drafts"
            >
              <Icon name="file" size={16} />
            </NavButton>
            {isTeam ? (
              // All-projects is a TEAM-scoped grid (EntryShell.tsx feeds it from
              // `teamProjects`, not the personal project list) — a personal
              // workspace has no team catalog to show here at all. Rendering it
              // unconditionally left the item clickable in a personal workspace,
              // landing on a "还没有团队项目" empty state that names a concept
              // (团队项目) the current workspace cannot have.
              <NavButton
                active={view === 'all-projects'}
                ariaLabel={t('entry.navAllProjects')}
                tooltip={t('workspaceSwitcher.allProjectsTooltip')}
                onClick={() => selectView('all-projects')}
                testId="entry-nav-all-projects"
              >
                <Icon name="grid" size={16} />
              </NavButton>
            ) : null}
            <NavButton
              active={view === 'design-systems'}
              ariaLabel={t('entry.navDesignSystems')}
              tooltip={t('entry.navDesignSystems')}
              onClick={() => selectView('design-systems')}
              testId="entry-nav-design-systems"
            >
              <Icon name="palette" size={16} />
            </NavButton>
            <NavButton
              active={view === 'plugins'}
              ariaLabel={t('entry.navExtensions')}
              tooltip={t('entry.navExtensions')}
              onClick={() => selectView('plugins')}
              testId="entry-nav-plugins"
            >
              <Icon name="puzzle" size={16} />
            </NavButton>
            {/* Product decision (2026-07-20): 成员 and 数据大盘 leave the rail
                entirely — both surfaces live in B's console and the rail should
                not advertise them. Workspace 设置 stays, and still links OUT to
                that console rather than routing to an in-client view. Gate by B
                permissions, not workspaceType: a personal workspace owner can
                manage their workspace too. */}
            {canViewWorkspaceSettings && workspaceSettingsUrl ? (
              <a
                className="entry-nav-rail__btn"
                href={workspaceSettingsUrl}
                {...externalLinkProps}
                aria-label={t('entry.navWorkspaceSettings')}
                data-tooltip={t('entry.navWorkspaceSettings')}
                data-testid="entry-nav-workspace-settings"
              >
                <span className="entry-nav-rail__btn-icon" aria-hidden>
                  <Icon name="settings" size={16} />
                </span>
                <span className="entry-nav-rail__btn-label">{t('entry.navWorkspaceSettings')}</span>
              </a>
            ) : null}
          </div>
        ) : (
          <>
            <NavButton
              active={view === 'design-systems'}
              ariaLabel={t('entry.navDesignSystems')}
              tooltip={t('entry.navDesignSystems')}
              onClick={() => selectView('design-systems')}
              testId="entry-nav-design-systems"
            >
              <Icon name="palette" size={16} />
            </NavButton>
            <NavButton
              active={view === 'plugins'}
              ariaLabel={t('entry.navExtensions')}
              tooltip={t('entry.navExtensions')}
              onClick={() => selectView('plugins')}
              testId="entry-nav-plugins"
            >
              <Icon name="puzzle" size={16} />
            </NavButton>
            {/* Signed-in workspace users keep Settings in the account menu.
                Signed-out/local users have no account menu, so retain one
                direct rail entry for local CLI and BYOK configuration. */}
            <NavButton
              active={false}
              ariaLabel={t('entry.openSettingsAria')}
              tooltip={t('entry.openSettingsTitle')}
              onClick={() => onOpenSettings?.()}
              testId="entry-nav-settings"
            >
              <Icon name="settings" size={16} />
            </NavButton>
          </>
        )}
      </div>
      {/* Skip the footer entirely when it has nothing to show — an empty
          shell here read as a dead white strip under the account row. */}
      {footerNotice || footerExtra ? (
        <div className="entry-nav-rail__footer">
          {footerNotice}
          {footerExtra ? <div className="entry-rail-actions">{footerExtra}</div> : null}
        </div>
      ) : null}
      </div>

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        canAssignRoles={canInviteMembers}
        availableSeats={context?.seatSummary?.availableSeats}
        onUpgrade={
          workspaceSettingsUrl
            ? () => {
                window.open(
                  teamConsoleUrl(workspaceSettingsUrl, 'upgrade'),
                  '_blank',
                  'noopener,noreferrer',
                );
              }
            : undefined
        }
      />
    </nav>
  );
}
