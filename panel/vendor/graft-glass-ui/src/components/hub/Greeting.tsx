export function Greeting({
  name,
  envLabel,
  stats,
}: {
  name: string;
  envLabel?: string;
  stats?: string;
}) {
  const hour = new Date().getHours();
  const hello = hour < 5 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  return (
    <div className="mb-5">
      <h1 className="text-[28px] md:text-[32px] font-[600] tracking-[-0.03em] text-ink">
        {hello}, {name} <span aria-hidden>👋</span>
      </h1>
      <p className="mt-1.5 text-[13.5px] text-ink/45">
        {[envLabel, stats].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}
