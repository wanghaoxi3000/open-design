// @vitest-environment jsdom
//
// Regression for #5971 removing the signed-out Settings entry together with
// the old footer chip. Signed-in workspace users keep Settings in their account
// menu and must not gain another rail entry.

import { cleanup, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

afterEach(() => {
  cleanup();
});

function workspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    teamName: 'OD Feature Team',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
  } as unknown as WorkspaceCollabContext;
}

describe('EntryNavRail settings entry', () => {
  it('renders one settings entry when there is no workspace context', () => {
    const onOpenSettings = vi.fn();
    render(
      <I18nProvider initial="en">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          onClose={() => {}}
          context={null}
          onOpenSettings={onOpenSettings}
          footerExtra={<button type="button" data-testid="fake-updater-popup" />}
        />
      </I18nProvider>,
    );

    expect(screen.getAllByTestId('entry-nav-settings')).toHaveLength(1);
    expect(screen.getByTestId('fake-updater-popup')).toBeTruthy();
    screen.getByTestId('entry-nav-settings').click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not add a rail settings entry for a signed-in workspace user', () => {
    render(
      <I18nProvider initial="en">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          onClose={() => {}}
          context={workspaceContext()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('entry-nav-settings')).toBeNull();
  });
});
