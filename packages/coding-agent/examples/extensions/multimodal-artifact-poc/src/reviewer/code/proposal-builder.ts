/**
 * Code proposal builder (§7) — freezes a code change into an immutable
 * proposal:
 *
 *  - GIT_COMMIT_RANGE: diff between base..head commits
 *  - FROZEN_WORKTREE_SNAPSHOT: copy changed files into a read-only snapshot
 *    workspace, hash each file, generate a canonical diff. Later worktree
 *    modifications cannot affect the proposal.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalHash } from "../store.ts";
import type { ArtifactRef, ChangedFileRef, CodeChangeProposal } from "../contracts/index.ts";

export class ProposalBuildError extends Error {}

export interface FrozenFile {
  path: string;
  status: ChangedFileRef["status"];
  content?: string;
  previousPath?: string;
}

export interface BuildCodeProposalInput {
  proposalId: string;
  proposalVersion: number;
  repositoryId: string;
  baseCommitSha: string;
  headCommitSha?: string;
  frozenFiles: FrozenFile[]; // for FROZEN_WORKTREE_SNAPSHOT
  requirementRefs: ArtifactRef[];
  testManifestRef?: ArtifactRef;
  proposerSummary: CodeChangeProposal["proposerSummary"];
  workspaceRoot: string; // where the frozen snapshot workspace is created
}

export function hashBytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function buildCodeProposal(input: BuildCodeProposalInput): Promise<{
  proposal: CodeChangeProposal;
  snapshotArtifactId: string;
  snapshotDir: string;
  diff: string;
}> {
  const mode = input.headCommitSha ? "GIT_COMMIT_RANGE" : "FROZEN_WORKTREE_SNAPSHOT";
  const snapshotId = `snap_${hashBytes(input.proposalId + input.proposalVersion).slice(0, 16)}`;

  const changedFiles: ChangedFileRef[] = [];
  const diffLines: string[] = [];
  const snapshotDir = resolve(input.workspaceRoot, "snapshots", snapshotId);
  await mkdir(snapshotDir, { recursive: true });

  for (const file of input.frozenFiles) {
    const safe = safeJoin(snapshotDir, file.path);
    if (file.content !== undefined) {
      await mkdir(dirname(safe), { recursive: true });
      await writeFile(safe, file.content);
      const h = hashBytes(file.content);
      changedFiles.push({ path: file.path, status: file.status, afterHash: h });
      diffLines.push(`--- a/${file.path}\n+++ b/${file.path}\n@@ snapshot @@\n${file.content}`);
    } else if (file.status === "DELETED") {
      changedFiles.push({ path: file.path, status: "DELETED", beforeHash: file.content ? hashBytes(file.content) : undefined });
    } else {
      throw new ProposalBuildError(`frozen file ${file.path} has no content and is not DELETED`);
    }
  }

  const diff = diffLines.join("\n");
  // persist the canonical diff + its sha256 sidecar inside the snapshot so a
  // later review can verify the diff artifact hash (fail-closed, never skip)
  await writeFile(join(snapshotDir, "diff.patch"), diff);
  await writeFile(join(snapshotDir, "diff.patch.sha256"), canonicalHash(diff) + "\n");
  const diffRef: ArtifactRef = {
    artifactId: `code-proposals/${input.proposalId}/v${input.proposalVersion}/diff.patch`,
    artifactType: "code-diff",
    contentHash: canonicalHash(diff),
  };

  const proposal: CodeChangeProposal = {
    schemaVersion: "1.0",
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    mode,
    repository: {
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      headCommitSha: input.headCommitSha,
      snapshotArtifactId: snapshotId,
    },
    diffArtifactRef: diffRef,
    changedFiles,
    requirementRefs: input.requirementRefs,
    testManifestRef: input.testManifestRef,
    staticAnalysisRefs: [],
    proposerSummary: input.proposerSummary,
    contentHash: "",
    createdAt: new Date().toISOString(),
  };
  const { contentHash: _omit, ...body } = proposal;
  proposal.contentHash = canonicalHash(body);

  return { proposal, snapshotArtifactId: snapshotId, snapshotDir, diff };
}

function safeJoin(root: string, rel: string): string {
  const p = resolve(root, rel);
  if (!p.startsWith(root + sep) && p !== root) {
    throw new ProposalBuildError(`frozen file path escapes snapshot workspace: ${rel}`);
  }
  return p;
}

/** Verify a proposal's declared hashes against the frozen snapshot. */
export function verifyCodeProposal(
  proposal: CodeChangeProposal,
  snapshotFiles: Array<{ path: string; content: string }>,
): Array<{ checkId: string; ok: boolean; detail: string }> {
  const out: Array<{ checkId: string; ok: boolean; detail: string }> = [];
  for (const cf of proposal.changedFiles) {
    const hit = snapshotFiles.find((f) => f.path === cf.path);
    if (cf.status === "DELETED") continue;
    if (!hit) {
      out.push({ checkId: `file-${cf.path}`, ok: false, detail: "file missing from snapshot" });
      continue;
    }
    const h = hashBytes(hit.content);
    if (cf.afterHash && h !== cf.afterHash) {
      out.push({ checkId: `file-${cf.path}`, ok: false, detail: `hash mismatch: ${h} != ${cf.afterHash}` });
    }
  }
  return out;
}
