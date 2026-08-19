import { HubApp } from "../../components/HubApp";

export function generateStaticParams() {
  return [
    { slug: [] },
    { slug: ["skills"] },
    { slug: ["updates"] },
    { slug: ["workspaces"] },
    { slug: ["store"] },
    { slug: ["codex"] },
    { slug: ["settings"] },
  ];
}

export default function Page() {
  return (
    <>
      <nav className="sr-only" aria-label="Skill Hub">
        <a href="/">总览</a>
        <a href="/skills">技能库</a>
        <a href="/updates">更新中心</a>
        <a href="/workspaces">工作区</a>
        <a href="/store">商店</a>
        <a href="/codex">Codex 助手</a>
        <a href="/settings">设置</a>
      </nav>
      <HubApp />
    </>
  );
}
