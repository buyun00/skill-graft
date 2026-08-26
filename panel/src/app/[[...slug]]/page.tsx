import { HubApp } from "../../components/HubApp";

export function generateStaticParams() {
  return [
    { slug: [] },
    { slug: ["setup"] },
    { slug: ["setup", "analysis"] },
    { slug: ["setup", "results"] },
    { slug: ["setup", "preview"] },
    { slug: ["setup", "success"] },
    { slug: ["library"] },
    { slug: ["changes"] },
    { slug: ["changes", "compare"] },
    { slug: ["changes", "result"] },
    { slug: ["changes", "success"] },
    { slug: ["workspaces"] },
    { slug: ["workspaces", "connect"] },
    { slug: ["workspaces", "connect", "mode"] },
    { slug: ["workspaces", "connect", "merge"] },
    { slug: ["workspaces", "connect", "merged"] },
    { slug: ["workspaces", "connect", "takeover"] },
    { slug: ["workspaces", "connect", "taken-over"] },
    { slug: ["assistant"] },
    { slug: ["diagnostics"] },
  ];
}

export default function Page() {
  return (
    <>
      <nav className="sr-only" aria-label="Skill Hub">
        <a href="/">首页</a>
        <a href="/library">中心库</a>
        <a href="/changes">新修改</a>
        <a href="/workspaces">工作区</a>
        <a href="/assistant">AI 助手</a>
        <a href="/diagnostics">高级诊断</a>
      </nav>
      <HubApp />
    </>
  );
}
