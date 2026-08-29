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
  librarySkillCount,
  connectedSkillCount,
  git,
  repository,
  codex,
  storage,
  workspacesLoading,
  workspacesError,
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
  librarySkillCount?: number;
  connectedSkillCount?: number;
  git?: { status: HubStatus; label: string };
  repository?: { status: HubStatus; label: string };
  codex?: { status: HubStatus; label: string };
  storage?: string;
  workspacesLoading?: boolean;
  workspacesError?: string;
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
  const workspacesFailed = Boolean(workspacesError);
  const workspacesPending = workspacesLoading === true;
  const workspacePhase = workspacesPending
    ? {
        title: "技能库已加载",
        description: "阶段 2/3 · 正在扫描工作树连接状态；完成前不会判定工作区正常。",
      }
    : workspacesFailed
      ? {
          title: "工作树状态未知",
          description: "工作树扫描失败，请刷新后重试。",
        }
      : null;
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
            {workspacePhase && items.length ? (
              <div className="glass mb-4 rounded-[18px] px-5 py-4 text-[13px] text-ink/55">
                <div className="font-[600] text-ink/70">{workspacePhase.title}</div>
                <div className="mt-1">{workspacePhase.description}</div>
              </div>
            ) : null}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-4 items-start">
              {items.length ? (
                <AttentionList
                  items={items}
                  onPrimary={onAttentionPrimary}
                  onSecondary={onAttentionSecondary}
                  onSeeAll={onSeeAllAttention}
                />
              ) : (
                <HubEmpty
                  title={workspacePhase?.title}
                  description={workspacePhase?.description}
                  actionLabel={workspacePhase ? "" : undefined}
                  onAction={onEmptyAction}
                />
              )}
              <WorkspacePanel
                items={workspaces ?? []}
                onSeeAll={onSeeAllWorkspaces}
                onSelect={onSelectWorkspace}
              />
            </div>
            <StatusBar
              librarySkillCount={librarySkillCount}
              connectedSkillCount={connectedSkillCount}
              git={git}
              repository={repository}
              codex={codex}
              storage={storage}
              onRefresh={onRefresh}
            />
          </>
        )}
      </main>
    </div>
  );
}
