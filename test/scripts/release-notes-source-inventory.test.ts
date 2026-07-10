import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCompleteReleaseSourceInventory,
  buildReleaseSourceInventory,
  canonicalGitEnvironment,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs";
import { sourceContributionsFromInventory } from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

type CommitFiles = Record<string, string>;

let indexSequence = 0;

function git(
  cwd: string,
  args: string[],
  { env, input }: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {},
) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function withRepository<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-source-inventory-"));
  git(cwd, ["init", "-q", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "OpenClaw Test"]);
  git(cwd, ["config", "user.email", "test@openclaw.invalid"]);
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
}

function createCommit(
  cwd: string,
  {
    body,
    files,
    parents = [],
    subject,
    timestamp,
  }: {
    body?: string;
    files: CommitFiles;
    parents?: string[];
    subject: string;
    timestamp: number;
  },
) {
  indexSequence += 1;
  const indexPath = join(cwd, `.release-source-index-${indexSequence}`);
  const commitDate = new Date(timestamp * 1000).toISOString();
  const env = {
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    git(cwd, ["read-tree", "--empty"], { env });
    for (const [path, content] of Object.entries(files).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: content });
      git(cwd, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env });
    }
    const tree = git(cwd, ["write-tree"], { env });
    const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;
    return git(cwd, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
      env,
      input: message,
    });
  } finally {
    rmSync(indexPath, { force: true });
  }
}

function completeAssociations(owners: Map<string, number[]>) {
  return (commits: string[]) =>
    new Map(commits.map((commit) => [commit, owners.get(commit) ?? []]));
}

function completeEvidence(
  owners: Map<string, number[]>,
  pullRequests = new Map<
    number,
    null | {
      __typename: "Issue" | "PullRequest";
      mergedAt?: string | null;
      number: number;
    }
  >(),
) {
  return {
    resolveAssociations: completeAssociations(owners),
    resolvePullRequests: (numbers: number[]) =>
      new Map(
        numbers.map((number) => [
          number,
          pullRequests.has(number)
            ? (pullRequests.get(number) ?? null)
            : {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:01.000Z",
                number,
              },
        ]),
      ),
  };
}

function commitRecord(inventory: ReturnType<typeof buildReleaseSourceInventory>, commit: string) {
  const record = inventory.commits.find((entry) => entry.commit === commit);
  expect(record).toBeDefined();
  return record!;
}

describe("release source inventory", () => {
  it("enumerates divergent target ancestry and keeps contextual references out of ownership", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "README.md": "root\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const divergentBase = createCommit(cwd, {
        files: { ...rootFiles, "base-only.txt": "published line\n" },
        parents: [root],
        subject: "chore: divergent published base",
        timestamp: 20,
      });
      const directFiles = { ...rootFiles, "direct.txt": "direct work\n" };
      const direct = createCommit(cwd, {
        files: directFiles,
        parents: [root],
        subject: "fix: direct behavior",
        timestamp: 30,
      });
      const contextualFiles = { ...directFiles, "mainline.txt": "mainline\n" };
      const contextual = createCommit(cwd, {
        body: "Context: #999",
        files: contextualFiles,
        parents: [direct],
        subject: "fix: contextual follow-up",
        timestamp: 40,
      });
      const sideFiles = { ...directFiles, "side.txt": "side branch\n" };
      const side = createCommit(cwd, {
        files: sideFiles,
        parents: [direct],
        subject: "feat: side branch behavior",
        timestamp: 50,
      });
      const mergeFiles = { ...contextualFiles, "side.txt": "side branch\n" };
      const merge = createCommit(cwd, {
        files: mergeFiles,
        parents: [contextual, side],
        subject: "Merge branch 'side'",
        timestamp: 60,
      });
      const strict = createCommit(cwd, {
        body: "Source-PR: #102",
        files: { ...mergeFiles, "strict.txt": "strict source\n" },
        parents: [merge],
        subject: "fix: strict source ownership",
        timestamp: 70,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: divergentBase,
          cwd,
          sourceTargetRef: strict,
        },
        completeEvidence(new Map([[side, [101]]])),
      );

      expect(inventory.range.mergeBase).toBe(root);
      expect(inventory.partitions.commits.universe.members).toEqual(
        [direct, contextual, side, merge, strict].toSorted(),
      );
      expect(inventory.commits.map((entry) => entry.commit)).toEqual([
        direct,
        contextual,
        side,
        merge,
        strict,
      ]);
      expect(commitRecord(inventory, direct)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
      });
      expect(commitRecord(inventory, contextual)).toMatchObject({
        disposition: "direct",
        explicitPullRequestReferences: [],
        pullRequests: [],
        references: [999],
      });
      expect(commitRecord(inventory, side)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "association", number: 101, sourceCommit: side }],
        pullRequests: [101],
      });
      expect(commitRecord(inventory, merge)).toMatchObject({
        disposition: "structural-merge",
        parents: [contextual, side],
      });
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "explicit-reference", number: 102, sourceCommit: strict }],
        explicitPullRequestReferences: [102],
        pullRequests: [102],
      });
      expect(inventory.partitions.commits).toMatchObject({
        direct: { count: 2 },
        pullRequest: { count: 2 },
        structuralMerge: { count: 1 },
        universe: { count: 5 },
      });
      expect(inventory.partitions.pullRequests.included.members).toEqual([101, 102]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("requires strict ownership references to be merged pull requests by the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const strict = createCommit(cwd, {
        body: "Co-authored-by: Contributor <contributor@example.com>",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: strict source ownership (#501)",
        timestamp: 20,
      });
      const invalidEvidence = [
        {
          label: "issue",
          node: { __typename: "Issue" as const, number: 501 },
        },
        {
          label: "unmerged pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: null,
            number: 501,
          },
        },
        {
          label: "late pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: "1970-01-01T00:00:21.000Z",
            number: 501,
          },
        },
      ];

      for (const evidence of invalidEvidence) {
        const inventory = buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: strict },
          completeEvidence(new Map(), new Map([[501, evidence.node]])),
        );
        expect(commitRecord(inventory, strict), evidence.label).toMatchObject({
          disposition: "unresolved",
        });
        expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
          "is not a merged pull request by the source target cutoff",
        );
      }

      const inventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(
          new Map(),
          new Map([
            [
              501,
              {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:20.000Z",
                number: 501,
              },
            ],
          ]),
        ),
      );
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [501],
      });
      const source = sourceContributionsFromInventory(inventory, new Map([[strict, ["alice"]]]));
      expect(source.activeCommits[0].coauthors).toEqual(["alice"]);
      expect(source.coauthorsByReference.get(501)).toEqual(new Set(["alice"]));
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("resolves exact cherry provenance and fails closed on ambiguous trusted patches", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "ambiguous.txt": "value=old\n",
        "cherry.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const cherryOrigin = createCommit(cwd, {
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 20,
      });
      const ambiguousOrigin = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: ambiguous source",
        timestamp: 21,
      });
      const candidateOne = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate one",
        timestamp: 22,
      });
      const candidateTwo = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate two",
        timestamp: 23,
      });
      const patchIdCollision = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value  =  new\n" },
        parents: [root],
        subject: "fix: whitespace collision",
        timestamp: 24,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${cherryOrigin})`,
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 30,
      });
      const ambiguous = createCommit(cwd, {
        body: `(cherry picked from commit ${ambiguousOrigin})`,
        files: {
          ...rootFiles,
          "ambiguous.txt": "value = new\n",
          "cherry.txt": "new\n",
        },
        parents: [cherry],
        subject: "fix: ambiguous source",
        timestamp: 40,
      });
      const owners = new Map<string, number[]>([
        [cherryOrigin, [201]],
        [ambiguousOrigin, []],
        [candidateOne, [301]],
        [candidateTwo, [302]],
        [patchIdCollision, [303]],
      ]);

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [candidateOne, candidateTwo, patchIdCollision],
          sourceTargetRef: ambiguous,
        },
        completeEvidence(owners),
      );

      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "cherry-origin-association",
            number: 201,
            sourceCommit: cherryOrigin,
          },
        ],
        pullRequests: [201],
      });
      expect(commitRecord(inventory, ambiguous)).toMatchObject({
        disposition: "unresolved",
        pullRequests: [],
      });
      expect(inventory.unresolved).toContainEqual({
        commit: ambiguous,
        kind: "ownership",
        pullRequests: [301, 302],
        reason: "ownership evidence resolves to more than one pull request",
      });
      expect(inventory.unresolved.some((entry) => entry.pullRequests?.includes(303))).toBe(false);
      expect(inventory.partitions.pullRequests.included.members).toEqual([201]);
      expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
        "ownership evidence resolves to more than one pull request",
      );
    }));

  it("ignores provenance commits newer than the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const candidate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 15,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${candidate})`,
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 20,
      });
      const future = createCommit(cwd, {
        files: { ...rootFiles, "future.txt": "future\n", "state.txt": "new\n" },
        parents: [candidate],
        subject: "fix: future provenance",
        timestamp: 30,
      });
      const requestedAssociations: string[] = [];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [future],
          sourceTargetRef: cherry,
        },
        {
          resolveAssociations: (commits: string[]) => {
            requestedAssociations.push(...commits);
            return completeAssociations(new Map([[candidate, [201]]]))(commits);
          },
          resolvePullRequests: () => new Map(),
        },
      );

      expect(requestedAssociations).toContain(candidate);
      expect(requestedAssociations).not.toContain(future);
      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [201],
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("tracks exact revert parity and rejects a forged inverse", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const original = createCommit(cwd, {
        body: "Fixes #402",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: change state",
        timestamp: 20,
      });
      const siblingFiles = {
        ...rootFiles,
        "sibling.txt": "still active\n",
        "state.txt": "new\n",
      };
      const sibling = createCommit(cwd, {
        files: siblingFiles,
        parents: [original],
        subject: "fix: keep the same pull request active",
        timestamp: 25,
      });
      const revert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...siblingFiles, "state.txt": "old\n" },
        parents: [sibling],
        subject: 'Revert "fix: change state"',
        timestamp: 30,
      });
      const restore = createCommit(cwd, {
        body: `This reverts commit ${revert}.`,
        files: siblingFiles,
        parents: [revert],
        subject: 'Revert "Revert fix: change state"',
        timestamp: 40,
      });
      const replacement = createCommit(cwd, {
        body: "Fixes #402",
        files: {
          ...siblingFiles,
          "replacement.txt": "replacement\n",
          "state.txt": "old\n",
        },
        parents: [revert],
        subject: "fix: replace reverted issue work",
        timestamp: 45,
      });
      const forged = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [original],
        subject: 'Revert "fix: change state"',
        timestamp: 50,
      });
      const originalOnlyOwners = new Map<string, number[]>([[original, [401]]]);
      const owners = new Map<string, number[]>([
        [original, [401]],
        [sibling, [401]],
      ]);

      const fullyRevertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(originalOnlyOwners),
      );
      expect(fullyRevertedInventory.partitions.pullRequests.included.members).toEqual([]);
      expect(
        [...sourceContributionsFromInventory(fullyRevertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([401, 402]);

      const revertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(owners),
      );
      expect(commitRecord(revertedInventory, original).disposition).toBe("reverted");
      expect(commitRecord(revertedInventory, revert).disposition).toBe("direct");
      expect(revertedInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(
        [...sourceContributionsFromInventory(revertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([402]);
      expect(assertCompleteReleaseSourceInventory(revertedInventory)).toBe(revertedInventory);

      const restoredInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: restore },
        completeEvidence(owners),
      );
      expect(commitRecord(restoredInventory, original)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [401],
      });
      expect(commitRecord(restoredInventory, revert).disposition).toBe("reverted");
      expect(commitRecord(restoredInventory, restore).disposition).toBe("direct");
      expect(restoredInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(sourceContributionsFromInventory(restoredInventory).revertedReferences.size).toBe(0);
      expect(assertCompleteReleaseSourceInventory(restoredInventory)).toBe(restoredInventory);

      const replacementInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: replacement },
        completeEvidence(owners),
      );
      expect(sourceContributionsFromInventory(replacementInventory).revertedReferences.size).toBe(
        0,
      );

      const forgedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: forged },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, forged).disposition).toBe("unresolved");
      expect(forgedInventory.unresolved).toContainEqual({
        commit: forged,
        kind: "revert",
        reason: `revert does not exactly invert ancestor ${original}`,
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        "revert does not exactly invert ancestor",
      );
    }));

  it("fails closed when a forged shipped-baseline revert would hide an exact duplicate", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceDuplicate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: duplicate release patch",
        timestamp: 20,
      });
      const shippedOriginal = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: already shipped patch",
        timestamp: 30,
      });
      const forgedBaselineRevert = createCommit(cwd, {
        body: `This reverts commit ${shippedOriginal}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [shippedOriginal],
        subject: 'Revert "fix: already shipped patch"',
        timestamp: 40,
      });

      const shippedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedOriginal],
          sourceTargetRef: sourceDuplicate,
        },
        completeEvidence(new Map()),
      );
      expect(commitRecord(shippedInventory, sourceDuplicate)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [{ commits: [shippedOriginal], ref: shippedOriginal }],
      });

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            shippedRefs: [forgedBaselineRevert],
            sourceTargetRef: sourceDuplicate,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow(
        `shipped baseline ${forgedBaselineRevert} revert ${forgedBaselineRevert} does not exactly invert ${shippedOriginal}`,
      );
    }));

  it("accepts one terminal CHANGELOG-only child and requires complete association keys", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInitial release.\n",
        "src/app.ts": "export const value = 1;\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceFiles = {
        ...rootFiles,
        "src/app.ts": "export const value = 2;\n",
      };
      const sourceTarget = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: product behavior",
        timestamp: 20,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nFinal release notes.\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): finalize release notes",
        timestamp: 30,
      });
      const invalidFinalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInvalid release notes.\n",
          "src/app.ts": "export const value = 3;\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): mix product bytes",
        timestamp: 40,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map()),
      );
      expect(inventory.range.sourceTail).toMatchObject({
        commit: finalTarget,
        parent: sourceTarget,
        paths: ["CHANGELOG.md"],
        subject: "docs(changelog): finalize release notes",
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: invalidFinalTarget,
            sourceTargetRef: sourceTarget,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow("must be one association-free, reference-free CHANGELOG.md-only child");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) => ({
              allPullRequests: new Map(
                commits.map((commit) => [commit, commit === finalTarget ? [900] : []]),
              ),
              pullRequests: new Map(commits.map((commit) => [commit, []])),
            }),
          },
        ),
      ).toThrow("must be one association-free, reference-free CHANGELOG.md-only child");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) =>
              new Map(
                commits.filter((commit) => commit !== finalTarget).map((commit) => [commit, []]),
              ),
          },
        ),
      ).toThrow(`association evidence is missing commit ${finalTarget}`);
    }));
});
