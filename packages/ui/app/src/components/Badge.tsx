const colorMap: Record<string, string> = {
  blue: "bg-blue-500/15 text-blue-400",
  purple: "bg-purple-500/15 text-purple-400",
  amber: "bg-amber-500/15 text-amber-400",
  green: "bg-green-500/15 text-green-400",
  cyan: "bg-cyan-500/15 text-cyan-400",
  pink: "bg-pink-500/15 text-pink-400",
  zinc: "bg-zinc-500/15 text-zinc-400",
  indigo: "bg-indigo-500/15 text-indigo-400",
  violet: "bg-violet-500/15 text-violet-400",
  orange: "bg-orange-500/15 text-orange-400",
  red: "bg-red-500/15 text-red-400",
};

interface BadgeProps {
  label: string;
  color?: string;
  size?: "sm" | "md";
}

export default function Badge({ label, color = "zinc", size = "sm" }: BadgeProps) {
  const cls = colorMap[color] ?? colorMap.zinc;
  const sizeClass = size === "md" ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs";
  return (
    <span className={`inline-flex items-center rounded font-medium ${sizeClass} ${cls}`}>
      {label}
    </span>
  );
}
