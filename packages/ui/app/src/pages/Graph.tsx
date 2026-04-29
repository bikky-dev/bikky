import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../lib/api";
import { CATEGORY_COLORS } from "../lib/format";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  factCount: number;
  categories: string[];
  primaryCategory: string;
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  weight: number;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  factCount: number;
  factsScanned?: number;
  truncated?: boolean;
  limit?: number;
  topN?: number | null;
  maxNodes?: number;
  maxEdges?: number;
  minWeight?: number;
  nodesPruned?: number;
  totalNodes?: number;
  edgesPruned?: number;
  totalEdges?: number;
  edgesFilteredByWeight?: number;
  denseFactsSkipped?: number;
  coOccurrenceEdgesSkipped?: number;
}

interface SharedFact {
  id: string;
  content: string;
  category: string;
  kind: string;
  entities: string[];
  created_at: string;
}

interface SharedResponse {
  entityA: string;
  entityB: string;
  facts: SharedFact[];
  count: number;
}

const CATEGORY_HEX: Record<string, string> = {
  engineering: "#3b82f6",
  product: "#6366f1",
  human: "#ec4899",
  system: "#f59e0b",
  // Legacy facts may still carry pre-ontology category values.
  codebase: "#3b82f6",
  infrastructure: "#3b82f6",
  operations: "#f97316",
  decisions: "#a855f7",
  product_domain: "#6366f1",
  observations: "#f59e0b",
  observation: "#f59e0b",
  preferences: "#22c55e",
  projects: "#06b6d4",
  people: "#ec4899",
  team: "#ec4899",
};

const GRAPH_MAX_NODES = 75;
const GRAPH_MAX_EDGES = 300;
const GRAPH_SERVER_MIN_WEIGHT = 1;
const MAX_SIMULATION_TICKS = 500;
const SIMULATION_WARMUP_TICKS = 60;

// Canonical four-category ontology shown in the legend.
const LEGEND_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "engineering", label: "Engineering" },
  { key: "product", label: "Product" },
  { key: "human", label: "Human" },
  { key: "system", label: "System" },
];

export default function Graph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [minWeight, setMinWeight] = useState(1);
  const [selectedEdge, setSelectedEdge] = useState<{ a: string; b: string } | null>(null);
  const [sharedFacts, setSharedFacts] = useState<SharedFact[]>([]);
  const [sharedLoading, setSharedLoading] = useState(false);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Mutable interaction state in refs (avoids re-render cascades)
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const hoveredEdgeRef = useRef<GraphEdge | null>(null);
  const selectedEdgeRef = useRef<{ a: string; b: string } | null>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ node: GraphNode | null; startX: number; startY: number }>({
    node: null,
    startX: 0,
    startY: 0,
  });
  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);

  // Stable ref-based callback for selecting an edge (called from event handlers)
  const selectEdgeRef = useRef((a: string, b: string) => {
    const sel = { a, b };
    selectedEdgeRef.current = sel;
    setSelectedEdge(sel);
    setSharedLoading(true);
    setSharedFacts([]);
    apiFetch<SharedResponse>(`/api/memory/shared?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((res) => setSharedFacts(res.facts))
      .catch(() => setSharedFacts([]))
      .finally(() => setSharedLoading(false));
  });
  const clearEdgeRef = useRef(() => {
    selectedEdgeRef.current = null;
    setSelectedEdge(null);
    setSharedFacts([]);
  });

  useEffect(() => {
    // Server-side graph budgets keep d3-force responsive on large memory stores.
    apiFetch<GraphData>(`/api/memory/graph?maxNodes=${GRAPH_MAX_NODES}&maxEdges=${GRAPH_MAX_EDGES}&minWeight=${GRAPH_SERVER_MIN_WEIGHT}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // draw reads all state from refs — stable function, no deps
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { x: tx, y: ty, k } = transformRef.current;
    const w = canvas.width;
    const h = canvas.height;
    const hovered = hoveredNodeRef.current;
    const hovEdge = hoveredEdgeRef.current;
    const selEdge = selectedEdgeRef.current;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    // Draw edges
    for (const edge of edges) {
      const source = edge.source as GraphNode;
      const target = edge.target as GraphNode;
      if (source.x == null || target.x == null) continue;

      const isSelected =
        selEdge &&
        ((source.id === selEdge.a && target.id === selEdge.b) ||
          (source.id === selEdge.b && target.id === selEdge.a));
      const isHovered = hovEdge === edge;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y!);
      ctx.lineTo(target.x, target.y!);

      if (isSelected) {
        ctx.strokeStyle = "rgba(250, 204, 21, 0.9)";
        ctx.lineWidth = 3;
      } else if (isHovered) {
        ctx.strokeStyle = "rgba(250, 250, 250, 0.7)";
        ctx.lineWidth = 2.5;
      } else if (edge.type !== "co-occurrence") {
        ctx.strokeStyle = "rgba(168, 85, 247, 0.5)";
        ctx.lineWidth = 2;
      } else {
        const alpha = Math.min(0.15 + edge.weight * 0.05, 0.6);
        ctx.strokeStyle = `rgba(113, 113, 122, ${alpha})`;
        ctx.lineWidth = Math.min(0.5 + edge.weight * 0.3, 3);
      }
      ctx.stroke();

      // Label typed relations
      if (edge.type !== "co-occurrence") {
        const mx = (source.x + target.x) / 2;
        const my = (source.y! + target.y!) / 2;
        ctx.fillStyle = "rgba(168, 85, 247, 0.8)";
        ctx.font = "9px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(edge.type, mx, my - 4);
      }
    }

    // Draw nodes
    for (const node of nodes) {
      if (node.x == null) continue;
      const radius = Math.max(4, Math.min(Math.sqrt(node.factCount) * 3, 24));
      const color = CATEGORY_HEX[node.primaryCategory] ?? "#71717a";
      const isHovered = hovered?.id === node.id;

      // Glow for hovered
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y!, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = `${color}33`;
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y!, radius, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? color : `${color}cc`;
      ctx.fill();
      ctx.strokeStyle = isHovered ? "#fff" : `${color}`;
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      // Label
      ctx.fillStyle = "#e4e4e7";
      ctx.font = `${isHovered ? "bold " : ""}${radius > 8 ? 11 : 9}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(node.label, node.x, node.y! + radius + 12);
    }

    ctx.restore();
  }, []);

  // Set up simulation when data arrives
  useEffect(() => {
    if (!data || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const w = canvas.parentElement!.clientWidth;
    const h = canvas.parentElement!.clientHeight;
    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Filter edges by minWeight for co-occurrence, keep all typed relations
    const filteredEdges = data.edges.filter(
      (e) => e.type !== "co-occurrence" || e.weight >= minWeight,
    );

    // Hide nodes left disconnected after the minWeight filter so they don't
    // float around as orphan dots cluttering the canvas.
    const connectedIds = new Set<string>();
    for (const edge of filteredEdges) {
      const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
      const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
      connectedIds.add(sourceId);
      connectedIds.add(targetId);
    }
    const visibleNodes = data.nodes.filter((n) => connectedIds.has(n.id));

    // Clone for simulation (d3 mutates these). Seed positions in a wide
    // ring so the first frame already looks centered and spread out.
    const ringRadius = Math.min(w, h) * 0.4;
    const nodes: GraphNode[] = visibleNodes.map((n, i) => {
      const theta = (i / Math.max(visibleNodes.length, 1)) * Math.PI * 2;
      return {
        ...n,
        x: Math.cos(theta) * ringRadius,
        y: Math.sin(theta) * ringRadius,
      };
    });
    const edges: GraphEdge[] = filteredEdges.map((e) => ({
      ...e,
      source: typeof e.source === "string" ? e.source : e.source.id,
      target: typeof e.target === "string" ? e.target : e.target.id,
    }));

    nodesRef.current = nodes;
    edgesRef.current = edges;

    // Center transform
    transformRef.current = { x: w / 2, y: h / 2, k: 1 };

    let tickCount = 0;
    const sim = forceSimulation(nodes)
      .alphaDecay(0.03)
      .force(
        "link",
        forceLink<GraphNode, GraphEdge>(edges)
          .id((d) => d.id)
          .distance((d) => Math.max(110, 200 - (d as GraphEdge).weight * 10))
          .strength((d) => Math.min(0.05 + (d as GraphEdge).weight * 0.02, 0.35)),
      )
      .force("charge", forceManyBody<GraphNode>().strength((d) => -400 - d.factCount * 4).distanceMax(600))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<GraphNode>().radius((d) => Math.sqrt(d.factCount) * 3 + 32).strength(0.9))
      .stop();

    // Warm-up ticks before first paint so the layout is roughly settled and
    // doesn't visibly jitter into place.
    for (let i = 0; i < SIMULATION_WARMUP_TICKS; i++) sim.tick();

    // Fit warm-up result to viewport. We do NOT scale up beyond 1.0 — small
    // graphs stay at natural size so nodes don't bunch near the center.
    const padding = 80;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (isFinite(minX) && maxX > minX && maxY > minY) {
      const graphW = maxX - minX;
      const graphH = maxY - minY;
      const scale = Math.min(
        (w - padding * 2) / graphW,
        (h - padding * 2) / graphH,
        1.0,
      );
      transformRef.current = {
        x: w / 2 - ((minX + maxX) / 2) * scale,
        y: h / 2 - ((minY + maxY) / 2) * scale,
        k: scale,
      };
    }

    sim.on("tick", () => {
      draw();
      tickCount++;
      if (tickCount >= MAX_SIMULATION_TICKS) sim.stop();
    });
    sim.alpha(0.6).restart();

    simRef.current = sim;
    draw();

    return () => {
      sim.stop();
    };
  }, [data, minWeight, draw]);

  // Zoom helper — zoom toward center of canvas
  const zoomBy = useCallback(
    (factor: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const t = transformRef.current;
      t.x = cx - (cx - t.x) * factor;
      t.y = cy - (cy - t.y) * factor;
      t.k *= factor;
      draw();
    },
    [draw],
  );

  const resetView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    transformRef.current = { x: rect.width / 2, y: rect.height / 2, k: 1 };
    draw();
  }, [draw]);

  // Mouse interaction handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function getNodeAt(clientX: number, clientY: number): GraphNode | null {
      const rect = canvas!.getBoundingClientRect();
      const { x: tx, y: ty, k } = transformRef.current;
      const mx = (clientX - rect.left - tx) / k;
      const my = (clientY - rect.top - ty) / k;

      for (const node of nodesRef.current) {
        if (node.x == null) continue;
        const r = Math.max(4, Math.min(Math.sqrt(node.factCount) * 3, 24));
        const dx = node.x - mx;
        const dy = node.y! - my;
        if (dx * dx + dy * dy < (r + 4) * (r + 4)) return node;
      }
      return null;
    }

    // Point-to-segment distance for edge hit-testing
    function getEdgeAt(clientX: number, clientY: number): GraphEdge | null {
      const rect = canvas!.getBoundingClientRect();
      const { x: tx, y: ty, k } = transformRef.current;
      const mx = (clientX - rect.left - tx) / k;
      const my = (clientY - rect.top - ty) / k;
      const threshold = 6 / k; // 6 CSS px tolerance, scale-adjusted

      let closest: GraphEdge | null = null;
      let closestDist = threshold;

      for (const edge of edgesRef.current) {
        const s = edge.source as GraphNode;
        const t = edge.target as GraphNode;
        if (s.x == null || t.x == null) continue;

        const ax = s.x, ay = s.y!;
        const bx = t.x, by = t.y!;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        // Project point onto segment, clamped to [0,1]
        const param = Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / lenSq));
        const px = ax + param * dx;
        const py = ay + param * dy;
        const dist = Math.sqrt((mx - px) * (mx - px) + (my - py) * (my - py));

        if (dist < closestDist) {
          closestDist = dist;
          closest = edge;
        }
      }
      return closest;
    }

    function onMouseDown(e: PointerEvent) {
      canvas!.setPointerCapture(e.pointerId);
      const node = getNodeAt(e.clientX, e.clientY);
      if (node) {
        dragRef.current = { node, startX: e.clientX, startY: e.clientY };
        node.fx = node.x;
        node.fy = node.y;
        simRef.current?.alphaTarget(0.3).restart();
        canvas!.style.cursor = "grabbing";
      } else {
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        // Store start for click-vs-pan detection
        dragRef.current = { node: null, startX: e.clientX, startY: e.clientY };
        canvas!.style.cursor = "grabbing";
      }
    }

    function onMouseMove(e: PointerEvent) {
      if (dragRef.current.node) {
        const { k } = transformRef.current;
        const rect = canvas!.getBoundingClientRect();
        const { x: tx, y: ty } = transformRef.current;
        dragRef.current.node.fx = (e.clientX - rect.left - tx) / k;
        dragRef.current.node.fy = (e.clientY - rect.top - ty) / k;
        return;
      }
      if (isPanningRef.current) {
        const ps = panStartRef.current;
        transformRef.current.x += e.clientX - ps.x;
        transformRef.current.y += e.clientY - ps.y;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        draw();
        return;
      }
      const node = getNodeAt(e.clientX, e.clientY);
      hoveredNodeRef.current = node;
      setHoveredNode(node);
      if (node) {
        if (hoveredEdgeRef.current) { hoveredEdgeRef.current = null; draw(); }
        canvas!.style.cursor = "pointer";
      } else {
        const edge = getEdgeAt(e.clientX, e.clientY);
        if (edge !== hoveredEdgeRef.current) {
          hoveredEdgeRef.current = edge;
          draw();
        }
        canvas!.style.cursor = edge ? "pointer" : "grab";
      }
    }

    function onMouseUp(e: PointerEvent) {
      canvas!.releasePointerCapture(e.pointerId);
      if (dragRef.current.node) {
        const moved =
          Math.abs(e.clientX - dragRef.current.startX) + Math.abs(e.clientY - dragRef.current.startY);
        if (moved < 5) {
          navigateRef.current(`/memory/entities/${encodeURIComponent(dragRef.current.node.id)}`);
        }
        dragRef.current.node.fx = null;
        dragRef.current.node.fy = null;
        dragRef.current = { node: null, startX: 0, startY: 0 };
        simRef.current?.alphaTarget(0);
      } else if (isPanningRef.current) {
        const moved =
          Math.abs(e.clientX - dragRef.current.startX) + Math.abs(e.clientY - dragRef.current.startY);
        if (moved < 5) {
          // Click on empty space — check for edge hit
          const edge = getEdgeAt(e.clientX, e.clientY);
          if (edge) {
            const s = edge.source as GraphNode;
            const t = edge.target as GraphNode;
            selectEdgeRef.current(s.id, t.id);
            draw();
          } else {
            clearEdgeRef.current();
            draw();
          }
        }
        dragRef.current = { node: null, startX: 0, startY: 0 };
      }
      isPanningRef.current = false;
      canvas!.style.cursor = "grab";
    }

    function onMouseLeave() {
      // Don't interrupt active drag/pan — pointer capture keeps delivering events
      if (isPanningRef.current || dragRef.current.node) return;
      hoveredNodeRef.current = null;
      if (hoveredEdgeRef.current) { hoveredEdgeRef.current = null; draw(); }
      setHoveredNode(null);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const zoom = e.deltaY < 0 ? 1.1 : 0.9;
      const t = transformRef.current;
      t.x = mx - (mx - t.x) * zoom;
      t.y = my - (my - t.y) * zoom;
      t.k *= zoom;
      draw();
    }

    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onMouseDown);
    canvas.addEventListener("pointermove", onMouseMove);
    canvas.addEventListener("pointerup", onMouseUp);
    canvas.addEventListener("pointerleave", onMouseLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onMouseDown);
      canvas.removeEventListener("pointermove", onMouseMove);
      canvas.removeEventListener("pointerup", onMouseUp);
      canvas.removeEventListener("pointerleave", onMouseLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [draw]);

  const visibleEdgeCount = data
    ? data.edges.filter((e) => e.type !== "co-occurrence" || e.weight >= minWeight).length
    : 0;
  const visibleNodeCount = nodesRef.current.length;

  // Build a single concise prune note instead of stacking multiple banner lines.
  const pruneNotes: string[] = [];
  if (data?.truncated) {
    pruneNotes.push(`scanned first ${(data.factsScanned ?? data.factCount).toLocaleString()} facts`);
  }
  if (data && (data.nodesPruned ?? 0) > 0) {
    pruneNotes.push(`top ${data.nodes.length} of ${data.totalNodes?.toLocaleString() ?? "?"} entities`);
  }
  if (data && (data.edgesPruned ?? 0) > 0) {
    pruneNotes.push(`top ${data.edges.length} of ${data.totalEdges?.toLocaleString() ?? "?"} connections`);
  }
  if (data && (data.denseFactsSkipped ?? 0) > 0) {
    pruneNotes.push(`${data.denseFactsSkipped.toLocaleString()} dense facts skipped`);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h2 className="text-2xl font-bold">Entity Graph</h2>
          {data && (
            <p className="text-sm text-zinc-500 mt-1">
              {visibleNodeCount || data.nodes.length} entities · {visibleEdgeCount} connections · {data.factCount} facts
            </p>
          )}
          {data && pruneNotes.length > 0 && (
            <p className="text-xs text-amber-400/80 mt-1">Showing {pruneNotes.join(" · ")}.</p>
          )}
          {loading && <p className="text-sm text-zinc-500 mt-1">Loading graph data…</p>}
          {error && <p className="text-sm text-red-400 mt-1">Failed to load graph: {error}</p>}
        </div>
        {data && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Min co-occurrence:
              <input
                type="range"
                min={1}
                max={10}
                value={minWeight}
                onChange={(e) => setMinWeight(parseInt(e.target.value, 10))}
                className="w-24 accent-blue-500"
              />
              <span className="text-zinc-300 w-4">{minWeight}</span>
            </label>
            <div className="flex items-center gap-3">
              {LEGEND_CATEGORIES.map(({ key, label }) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CATEGORY_HEX[key] }} />
                  <span className="text-xs text-zinc-500">{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tooltip */}
      {hoveredNode && (
        <div className="absolute top-20 right-8 z-10 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-lg max-w-xs">
          <p className="text-sm font-medium text-white">{hoveredNode.label}</p>
          <p className="text-xs text-zinc-400 mt-1">{hoveredNode.factCount} facts</p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {hoveredNode.categories.map((cat) => (
              <span
                key={cat}
                className="text-xs px-1.5 py-0.5 rounded capitalize"
                style={{
                  backgroundColor: `${CATEGORY_HEX[cat] ?? "#71717a"}22`,
                  color: CATEGORY_HEX[cat] ?? "#71717a",
                }}
              >
                {cat}
              </span>
            ))}
          </div>
          <p className="text-xs text-zinc-500 mt-1.5">Click to explore</p>
        </div>
      )}

      <div ref={containerRef} className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden relative">
        <canvas ref={canvasRef} className="w-full h-full" />

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1">
          <button
            onClick={() => zoomBy(1.3)}
            className="w-9 h-9 rounded-lg bg-zinc-800/90 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors flex items-center justify-center text-lg font-bold backdrop-blur-sm"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={() => zoomBy(1 / 1.3)}
            className="w-9 h-9 rounded-lg bg-zinc-800/90 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors flex items-center justify-center text-lg font-bold backdrop-blur-sm"
            title="Zoom out"
          >
            −
          </button>
          <button
            onClick={resetView}
            className="w-9 h-9 rounded-lg bg-zinc-800/90 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors flex items-center justify-center text-xs font-medium backdrop-blur-sm mt-1"
            title="Reset view"
          >
            ⟲
          </button>
        </div>

        {/* Shared facts panel */}
        {selectedEdge && (
          <div className="absolute top-0 right-0 w-96 h-full bg-zinc-900/95 border-l border-zinc-700 backdrop-blur-sm overflow-y-auto z-20">
            <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Shared Memories</h3>
                <p className="text-xs text-yellow-400 mt-0.5">
                  {selectedEdge.a} ↔ {selectedEdge.b}
                </p>
              </div>
              <button
                onClick={() => { clearEdgeRef.current(); draw(); }}
                className="w-7 h-7 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-700 flex items-center justify-center text-sm"
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-3">
              {sharedLoading && (
                <p className="text-xs text-zinc-500 animate-pulse">Loading…</p>
              )}
              {!sharedLoading && sharedFacts.length === 0 && (
                <p className="text-xs text-zinc-500">No shared memories found.</p>
              )}
              {sharedFacts.map((fact) => (
                <div
                  key={fact.id}
                  onClick={() => navigateRef.current(`/memory/facts/${fact.id}`)}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 hover:border-zinc-600 cursor-pointer transition-colors"
                >
                  <p className="text-xs text-zinc-300 leading-relaxed">{fact.content}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded capitalize"
                      style={{
                        backgroundColor: `${CATEGORY_HEX[fact.category] ?? "#71717a"}22`,
                        color: CATEGORY_HEX[fact.category] ?? "#71717a",
                      }}
                    >
                      {fact.category}
                    </span>
                    {fact.kind !== "fact" && (
                      <span className="text-[10px] text-zinc-500">{fact.kind}</span>
                    )}
                    <span className="text-[10px] text-zinc-600 ml-auto">
                      {new Date(fact.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
