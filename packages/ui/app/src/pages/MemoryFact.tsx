import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router";
import { ArrowLeft, Pencil, Trash2, Loader2, Save, X } from "lucide-react";
import { apiFetch, ApiError } from "../lib/api";
import { relativeTime, CATEGORY_COLORS, KIND_COLORS } from "../lib/format";
import Badge from "../components/Badge";
import { EntityChip } from "../components/EntityChip";
import type { Fact } from "../components/FactCard";

const CATEGORIES = ["infrastructure", "decisions", "observation", "preferences", "projects", "team"];
const DOMAINS = ["work", "personal"];

export default function MemoryFact() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [fact, setFact] = useState<Fact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editDomain, setEditDomain] = useState("");
  const [editEntities, setEditEntities] = useState("");
  const [saving, setSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    apiFetch<Fact>(`/api/memory/facts/${id}`)
      .then((f) => {
        setFact(f);
        setEditContent(f.content);
        setEditCategory(f.category);
        setEditDomain(f.domain ?? "work");
        setEditEntities(f.entities.join(", "));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load fact"))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    if (!fact) return;
    setSaving(true);
    try {
      await apiFetch(`/api/memory/facts/${fact.id}`, {
        method: "PUT",
        body: JSON.stringify({
          content: editContent,
          category: editCategory,
          domain: editDomain,
          entities: editEntities.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const updated = await apiFetch<Fact>(`/api/memory/facts/${fact.id}`);
      setFact(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!fact) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/memory/facts/${fact.id}`, { method: "DELETE" });
      navigate("/memory");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  };

  const cancelEdit = () => {
    if (!fact) return;
    setEditing(false);
    setEditContent(fact.content);
    setEditCategory(fact.category);
    setEditDomain(fact.domain ?? "work");
    setEditEntities(fact.entities.join(", "));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (error && !fact) {
    return (
      <div>
        <button onClick={() => navigate("/memory")} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white mb-6">
          <ArrowLeft size={16} /> Back to Memory
        </button>
        <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (!fact) return null;

  const selectCls =
    "bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={() => navigate("/memory")} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white">
          <ArrowLeft size={16} /> Back to Memory
        </button>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-sm transition-colors"
              >
                <Pencil size={14} /> Edit
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-red-900/50 border border-zinc-700 hover:border-red-800 rounded-md text-sm text-red-400 transition-colors"
              >
                <Trash2 size={14} /> Delete
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save
              </button>
              <button
                onClick={cancelEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-sm transition-colors"
              >
                <X size={14} /> Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="mb-4 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 flex items-center justify-between">
          <span className="text-sm text-red-400">Delete this fact permanently?</span>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm font-medium transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Fact detail card */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        {/* Content */}
        {editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={5}
            className="w-full bg-zinc-950 border border-zinc-700 rounded-md p-3 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500 resize-y"
          />
        ) : (
          <p className="text-zinc-200 leading-relaxed whitespace-pre-wrap">{fact.content}</p>
        )}

        {/* Badges */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className={selectCls}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select value={editDomain} onChange={(e) => setEditDomain(e.target.value)} className={selectCls}>
                {DOMAINS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <Badge label={fact.category} color={CATEGORY_COLORS[fact.category]} size="md" />
              {fact.kind && <Badge label={fact.kind} color={KIND_COLORS[fact.kind]} size="md" />}
              {fact.domain && <Badge label={fact.domain} color={fact.domain === "personal" ? "green" : "zinc"} size="md" />}
              {fact.source && <Badge label={fact.source} size="md" />}
            </>
          )}
        </div>

        {/* Entities */}
        <div className="mt-4">
          <p className="text-xs text-zinc-500 mb-1.5">Entities</p>
          {editing ? (
            <input
              type="text"
              value={editEntities}
              onChange={(e) => setEditEntities(e.target.value)}
              placeholder="entity1, entity2"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {fact.entities.map((e) => (
                <EntityChip key={e} name={e} />
              ))}
              {fact.entities.length === 0 && (
                <span className="text-sm text-zinc-600">None</span>
              )}
            </div>
          )}
        </div>

        {/* Relation */}
        {fact.from_entity && fact.relation_type && fact.to_entity && (
          <div className="mt-4">
            <p className="text-xs text-zinc-500 mb-1.5">Relation</p>
            <div className="flex items-center gap-2 text-sm">
              <Link
                to={`/memory/entities/${encodeURIComponent(fact.from_entity)}`}
                className="text-blue-400 hover:underline"
              >
                {fact.from_entity}
              </Link>
              <span className="text-zinc-500">→</span>
              <Badge label={fact.relation_type} color="orange" />
              <span className="text-zinc-500">→</span>
              <Link
                to={`/memory/entities/${encodeURIComponent(fact.to_entity)}`}
                className="text-blue-400 hover:underline"
              >
                {fact.to_entity}
              </Link>
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="mt-6 pt-4 border-t border-zinc-800 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-zinc-500">Confidence</p>
            <p className="text-zinc-300">{Math.round(fact.confidence * 100)}%</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Created</p>
            <p className="text-zinc-300">{relativeTime(fact.created_at)}</p>
          </div>
          {fact.updated_at && (
            <div>
              <p className="text-xs text-zinc-500">Updated</p>
              <p className="text-zinc-300">{relativeTime(fact.updated_at)}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-zinc-500">ID</p>
            <p className="text-zinc-500 font-mono text-xs truncate">{fact.id}</p>
          </div>
        </div>

        <ProvenanceSection fact={fact} />
      </div>
    </div>
  );
}

function ProvenanceSection({ fact }: { fact: Fact }) {
  const fields: { label: string; value: string; render?: JSX.Element }[] = [];
  if (fact.workstream_key) fields.push({ label: "Workstream", value: fact.workstream_key });
  if (fact.task_key) fields.push({ label: "Task", value: fact.task_key });
  if (fact.repo) {
    const isGhRepo = /^[\w.-]+\/[\w.-]+$/.test(fact.repo);
    fields.push({
      label: "Repo",
      value: fact.repo,
      render: isGhRepo ? (
        <a
          href={`https://github.com/${fact.repo}`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-400 hover:underline font-mono text-xs"
        >
          {fact.repo}
        </a>
      ) : undefined,
    });
  }
  if (fact.branch) fields.push({ label: "Branch", value: fact.branch });
  if (fact.episode_id) fields.push({ label: "Episode", value: fact.episode_id });
  if (fact.session_id) fields.push({ label: "Session", value: fact.session_id });

  if (fields.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t border-zinc-800">
      <p className="text-xs text-zinc-500 mb-2">Provenance</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        {fields.map((f) => (
          <div key={f.label}>
            <p className="text-xs text-zinc-500">{f.label}</p>
            {f.render ?? <p className="text-zinc-300 font-mono text-xs break-all">{f.value}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}