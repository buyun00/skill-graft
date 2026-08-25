"use client";

import type { ReactNode } from "react";
import { Greeting } from "@/components/hub/Greeting";
import { HubEmpty } from "@/components/hub/HubEmpty";
import { HubSidebar, type HubNavId } from "@/components/hub/HubSidebar";
import { StatusBar } from "@/components/hub/StatusBar";
import { TopBar } from "@/components/hub/TopBar";
import { AttentionList, type AttentionItem } from "@/components/hub/AttentionList";
import { WorkspacePanel, type WorkspaceRow } from "@/components/hub/WorkspacePanel";
import type { AuthUser } from "@/components/ui/AuthCard";
import type { HubStatus } from "@/components/hub/StatusPill";

export function HubShell({
  active = "overview",
  user,
  updateCount,
  greetingName,
  envLabel,
  stats,
  attention,
  workspaces,
  git,
  codex,
  storage,
  contained,
  children,
  onNavigate,
  onSearch,
  onCreate,
  onNotify,
  onAttentionPrimary,
  onAttentionSecondary,
  onSeeAllAttention,
  onSeeAllWorkspaces,
  onSelectWorkspace,
  onEmptyAction,
  onRefresh,
}: {
  active?: HubNavId;
  user?: AuthUser | null;
  updateCount?: number;
  greetingName?: string;
  envLabel?: string;
  stats?: string;
  attention?: AttentionItem[];
  workspaces?: WorkspaceRow[];
  git?: { status: HubStatus; label: string };
  codex?: { status: HubStatus; label: string };
  storage?: string;
  contained?: boolean;
  children?: ReactNode;
  onNavigate?: (id: HubNavId) => void;
  onSearch?: () => void;
  onCreate?: () => void;
  onNotify?: () => void;
  onAttentionPrimary?: (item: AttentionItem) => void;
  onAttentionSecondary?: (item: AttentionItem) => void;
  onSeeAllAttention?: () => void;
  onSeeAllWorkspaces?: () => void;
  onSelectWorkspace?: (item: WorkspaceRow) => void;
  onEmptyAction?: () => void;
  onRefresh?: () => void;
}) {
  const items = attention ?? [];
  return (
    <div className={contained ? "relative min-h-[760px]" : undefined}>
      <HubSidebar
        active={active}
        updateCount={updateCount ?? items.length}
        user={user}
        contained={contained}
        onNavigate={onNavigate}
      />
      <main className="md:ml-[240px] min-h-screen px-5 md:px-8 py-6 pb-16">
        <TopBar
          notifyCount={items.length}
          onSearch={onSearch}
          onCreate={onCreate}
          onNotify={onNotify}
        />
        {children ?? (
          <>
            <Greeting
              name={greetingName || user?.name || "there"}
              envLabel={envLabel}
              stats={stats}
            />
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-4 items-start">
              {items.length ? (
                <AttentionList
                  items={items}
                  onPrimary={onAttentionPrimary}
                  onSecondary={onAttentionSecondary}
                  onSeeAll={onSeeAllAttention}
                />
              ) : (
                <HubEmpty onAction={onEmptyAction} />
              )}
              <WorkspacePanel
                items={workspaces ?? []}
                onSeeAll={onSeeAllWorkspaces}
                onSelect={onSelectWorkspace}
              />
            </div>
            <StatusBar git={git} codex={codex} storage={storage} onRefresh={onRefresh} />
          </>
        )}
      </main>
    </div>
  );
}
