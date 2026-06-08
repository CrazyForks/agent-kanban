import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { BoardSettingsNav } from "../components/BoardSettingsNav";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  useBoard,
  useBoardMaintainers,
  useCreateBoardMaintainer,
  useDeleteBoard,
  useDeleteBoardMaintainer,
  useUpdateBoard,
  useUpdateBoardMaintainer,
} from "../hooks/useBoard";
import { api } from "../lib/api";

interface BoardSettingsBoard {
  id: string;
  name: string;
  description?: string | null;
  visibility: "private" | "public";
  share_slug: string | null;
}

interface BoardMaintainer {
  id: string;
  name: string;
  prompt: string;
  status: "active" | "paused" | "archived";
  agent_id?: string;
  interval_seconds: number;
  last_run_at: string | null;
}

interface MaintainerAgent {
  id: string;
  name?: string;
  username?: string;
  role?: string;
  model?: string;
}

const BADGE_TYPES = [
  { type: "agents", label: "Agents", alt: "AK agents badge" },
  { type: "tasks", label: "Tasks", alt: "AK tasks badge" },
  { type: "tokens", label: "Tokens", alt: "AK tokens badge" },
] as const;

type BadgeType = (typeof BADGE_TYPES)[number]["type"];

export function BoardSettingsPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { board, loading } = useBoard(boardId);

  if (loading) return <BoardSettingsLoading />;
  if (!board || !boardId) return <BoardSettingsNotFound />;

  return <BoardSettingsContent board={board} boardId={boardId} />;
}

function BoardSettingsContent({ board, boardId }: { board: BoardSettingsBoard; boardId: string }) {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl p-6 sm:p-8">
        <div className="mb-6 space-y-4">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{board.name}</p>
            <h1 className="mt-1 text-xl font-bold text-content-primary">Board settings</h1>
          </div>
          <BoardSettingsNav boardId={boardId} />
        </div>

        <BoardDetailsSection board={board} boardId={boardId} />
        <BoardSharingSection board={board} boardId={boardId} />
        <BoardMaintainersSection boardId={boardId} />
        <BoardDangerSection board={board} />
      </main>
    </div>
  );
}

function BoardDetailsSection({ board, boardId }: { board: BoardSettingsBoard; boardId: string }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const updateBoard = useUpdateBoard();

  useEffect(() => {
    setName(board.name);
    setDescription(board.description || "");
  }, [board.id]);

  const hasChanges = name.trim() !== board.name || description.trim() !== (board.description || "");

  async function save() {
    try {
      await updateBoard.mutateAsync({ id: boardId, name: name.trim(), description: description.trim() });
      toast.success("Board settings saved");
    } catch {
      toast.error("Failed to save board settings");
    }
  }

  return (
    <Card size="sm">
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="board-name">
            Name
          </Label>
          <Input id="board-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="board-description">
            Description
          </Label>
          <Textarea
            id="board-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="What is this board for?"
            className="resize-none"
          />
        </div>
      </CardContent>

      <CardFooter className="justify-end border-t-0 bg-transparent pt-0">
        <Button onClick={save} disabled={updateBoard.isPending || !name.trim() || !hasChanges}>
          {updateBoard.isPending ? "Saving..." : "Save"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function BoardSharingSection({ board, boardId }: { board: BoardSettingsBoard; boardId: string }) {
  const updateBoard = useUpdateBoard();
  const isPublic = board.visibility === "public";
  const shareUrl = board.share_slug ? `${window.location.origin}/share/${board.share_slug}` : null;
  const badgeBaseUrl = board.share_slug ? `${window.location.origin}/api/share/${board.share_slug}/badge.svg` : null;

  async function toggleVisibility() {
    const nextVisibility = isPublic ? "private" : "public";
    try {
      await updateBoard.mutateAsync({ id: boardId, visibility: nextVisibility });
      toast.success(nextVisibility === "public" ? "Sharing enabled" : "Sharing disabled");
    } catch {
      toast.error("Failed to update sharing");
    }
  }

  async function copyShareText(type: "link" | BadgeType) {
    if (!shareUrl || !badgeBaseUrl) return;
    const text = type === "link" ? shareUrl : badgeMarkdown(shareUrl, badgeBaseUrl, type);
    try {
      await copyTextToClipboard(text);
      toast.success(type === "link" ? "Share link copied" : `${badgeLabel(type)} badge copied`);
    } catch {
      toast.error("Failed to copy");
    }
  }

  return (
    <Card className="mt-6" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Sharing</h2>
        </CardTitle>
        <CardDescription>Enable a public read-only board link and README badge.</CardDescription>
        <CardAction className="flex items-center gap-2 pl-4">
          <span className="text-xs text-content-tertiary">{isPublic ? "On" : "Off"}</span>
          <Switch
            checked={isPublic}
            aria-label={isPublic ? "Sharing on" : "Sharing off"}
            onCheckedChange={toggleVisibility}
            disabled={updateBoard.isPending}
          />
        </CardAction>
      </CardHeader>

      {isPublic && shareUrl && badgeBaseUrl && (
        <CardContent>
          <ShareLinks badgeBaseUrl={badgeBaseUrl} shareUrl={shareUrl} onCopy={copyShareText} />
        </CardContent>
      )}
    </Card>
  );
}

function BoardMaintainersSection({ boardId }: { boardId: string }) {
  const { maintainers, loading } = useBoardMaintainers(boardId);
  const updateMaintainer = useUpdateBoardMaintainer(boardId);
  const deleteMaintainer = useDeleteBoardMaintainer(boardId);
  const [createOpen, setCreateOpen] = useState(false);
  const [editMaintainer, setEditMaintainer] = useState<BoardMaintainer | null>(null);

  async function toggleStatus(maintainer: BoardMaintainer) {
    const status = maintainer.status === "active" ? "paused" : "active";
    try {
      await updateMaintainer.mutateAsync({ maintainerId: maintainer.id, body: { status } });
      toast.success(status === "active" ? "Maintainer resumed" : "Maintainer paused");
    } catch {
      toast.error("Failed to update maintainer");
    }
  }

  async function archive(maintainer: BoardMaintainer) {
    try {
      await deleteMaintainer.mutateAsync(maintainer.id);
      toast.success("Maintainer archived");
    } catch {
      toast.error("Failed to archive maintainer");
    }
  }

  return (
    <Card className="mt-6" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Maintainers</h2>
        </CardTitle>
        <CardDescription>Scheduled agents that inspect this board and act through AK commands.</CardDescription>
        <CardAction>
          <Button size="xs" onClick={() => setCreateOpen(true)}>
            Add maintainer
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : maintainers.length === 0 ? (
          <p className="text-sm text-content-tertiary">No maintainers configured.</p>
        ) : (
          <div className="divide-y divide-border">
            {(maintainers as BoardMaintainer[]).map((maintainer) => (
              <div key={maintainer.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${maintainer.status === "active" ? "bg-accent" : "bg-content-tertiary"}`} />
                    <p className="truncate text-sm font-medium text-content-primary">{maintainer.name}</p>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">{maintainer.status}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-content-tertiary">
                    agent={maintainer.agent_id ?? "unbound"} · every {formatInterval(maintainer.interval_seconds)}
                  </p>
                  <p className="mt-1 text-xs text-content-secondary">
                    Last run {maintainer.last_run_at ? formatRelative(maintainer.last_run_at) : "never"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="xs" onClick={() => setEditMaintainer(maintainer)}>
                    Edit
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => toggleStatus(maintainer)} disabled={updateMaintainer.isPending}>
                    {maintainer.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => archive(maintainer)} disabled={deleteMaintainer.isPending}>
                    Archive
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <MaintainerDialog boardId={boardId} open={createOpen} onOpenChange={setCreateOpen} />
      {editMaintainer && (
        <MaintainerDialog
          boardId={boardId}
          maintainer={editMaintainer}
          open
          onOpenChange={(open) => {
            if (!open) setEditMaintainer(null);
          }}
        />
      )}
    </Card>
  );
}

function MaintainerDialog({
  boardId,
  maintainer,
  open,
  onOpenChange,
}: {
  boardId: string;
  maintainer?: BoardMaintainer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = !!maintainer;
  const createMaintainer = useCreateBoardMaintainer(boardId);
  const updateMaintainer = useUpdateBoardMaintainer(boardId);
  const agentQuery = useQuery({ queryKey: ["agents", { kind: "worker" }], queryFn: () => api.agents.list(), enabled: open && !isEditing });
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("86400");

  useEffect(() => {
    if (!open) return;
    setName(maintainer?.name ?? "");
    setPrompt(maintainer?.prompt ?? "");
    setAgentId(maintainer?.agent_id ?? "");
    setIntervalSeconds(String(maintainer?.interval_seconds ?? 86400));
  }, [open, maintainer?.id]);

  const agents = (agentQuery.data ?? []) as MaintainerAgent[];
  const pending = createMaintainer.isPending || updateMaintainer.isPending;

  async function save() {
    const seconds = Number.parseInt(intervalSeconds, 10);
    if (!Number.isInteger(seconds) || seconds < 60) {
      toast.error("Interval must be at least 60 seconds");
      return;
    }
    if (!prompt.trim()) {
      toast.error("Prompt is required");
      return;
    }
    try {
      if (maintainer) {
        await updateMaintainer.mutateAsync({
          maintainerId: maintainer.id,
          body: { name: name.trim() || undefined, prompt: prompt.trim(), interval_seconds: seconds },
        });
        toast.success("Maintainer updated");
      } else {
        if (!agentId) {
          toast.error("Agent is required");
          return;
        }
        await createMaintainer.mutateAsync({
          name: name.trim() || undefined,
          prompt: prompt.trim(),
          agent_id: agentId,
          interval_seconds: seconds,
        });
        toast.success("Maintainer created");
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save maintainer");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit maintainer" : "Add maintainer"}</DialogTitle>
          <DialogDescription>Maintainers run on a schedule and use AK commands to inspect and operate this board.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="maintainer-name">Name</Label>
            <Input id="maintainer-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily maintainer" />
          </div>

          {!isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="maintainer-agent">Agent</Label>
              <select
                id="maintainer-agent"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm text-content-primary"
              >
                <option value="">Select an agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name ?? agent.username ?? agent.id}
                    {agent.role ? ` (${agent.role})` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="maintainer-interval">Interval seconds</Label>
            <Input
              id="maintainer-interval"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              inputMode="numeric"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maintainer-prompt">Prompt</Label>
            <Textarea
              id="maintainer-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="Inspect open work, create follow-up tasks when needed, and escalate proposals for human review."
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving..." : isEditing ? "Save changes" : "Create maintainer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareLinks({ badgeBaseUrl, shareUrl, onCopy }: { badgeBaseUrl: string; shareUrl: string; onCopy: (type: "link" | BadgeType) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-content-tertiary">Badge previews</p>
        <div className="space-y-2">
          {BADGE_TYPES.map((badge) => (
            <div key={badge.type} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <img src={badgeUrl(badgeBaseUrl, badge.type)} alt={badge.alt} className="h-5 max-w-full" />
              </div>
              <Button variant="outline" size="xs" onClick={() => onCopy(badge.type)}>
                Copy {badge.label.toLowerCase()}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-content-tertiary">Share link</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-primary px-3 py-2 text-[11px] text-content-secondary">
            {shareUrl}
          </code>
          <Button variant="outline" size="xs" onClick={() => onCopy("link")}>
            Copy link
          </Button>
        </div>
      </div>
    </div>
  );
}

function badgeUrl(baseUrl: string, type: BadgeType) {
  return `${baseUrl}?type=${type}`;
}

function badgeMarkdown(shareUrl: string, baseUrl: string, type: BadgeType) {
  return `[![AK ${badgeLabel(type)}](${badgeUrl(baseUrl, type)})](${shareUrl})`;
}

function badgeLabel(type: BadgeType) {
  return BADGE_TYPES.find((badge) => badge.type === type)!.label;
}

function formatInterval(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Copy failed");
  }
}

function BoardDangerSection({ board }: { board: BoardSettingsBoard }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const deleteBoard = useDeleteBoard();
  const navigate = useNavigate();

  async function deleteCurrentBoard() {
    await deleteBoard.mutateAsync(board.id);
    navigate("/");
  }

  return (
    <Card className="mt-6 ring-error/30" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Delete board</h2>
        </CardTitle>
        <CardDescription>Deletes this board and its tasks. This cannot be undone.</CardDescription>
        <CardAction>
          <Button variant="destructive" size="xs" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </CardAction>
      </CardHeader>
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setConfirmId("");
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete board</DialogTitle>
            <DialogDescription>Type this board ID to confirm deletion: {board.id}</DialogDescription>
          </DialogHeader>
          <Input
            value={confirmId}
            onChange={(event) => setConfirmId(event.target.value)}
            placeholder={board.id}
            aria-label="Board ID confirmation"
            className="font-mono"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteCurrentBoard} disabled={deleteBoard.isPending || confirmId !== board.id}>
              {deleteBoard.isPending ? "Deleting..." : "Delete board"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function BoardSettingsLoading() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl space-y-4 p-6 sm:p-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-36 rounded-lg" />
      </main>
    </div>
  );
}

function BoardSettingsNotFound() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="flex min-h-[60vh] items-center justify-center text-content-tertiary">Board not found</div>
    </div>
  );
}
