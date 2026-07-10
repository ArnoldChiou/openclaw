import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const objectIdPattern = /^[0-9a-f]{40}$/;
const maxBuffer = 128 * 1024 * 1024;
const repositoryRedirectVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

function fail(message) {
  throw new Error(message);
}

export function canonicalGitEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const variable of repositoryRedirectVariables) {
    delete environment[variable];
  }
  return { ...environment, GIT_NO_REPLACE_OBJECTS: "1", NO_COLOR: "1" };
}

function git(cwd, args, { input } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function gitBuffer(cwd, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed: ${
        result.stderr?.toString("utf8").trim() || result.signal || result.status
      }`,
    );
  }
  return result.stdout;
}

function resolveCommit(cwd, ref) {
  const commit = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!objectIdPattern.test(commit)) {
    fail(`${ref} did not resolve to an immutable commit`);
  }
  return commit;
}

function assertCanonicalRepository(cwd) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    fail("release source inventory refuses shallow Git repositories");
  }
  if (git(cwd, ["for-each-ref", "--format=%(refname)", "refs/replace"]).trim() !== "") {
    fail("release source inventory refuses Git replacement refs");
  }
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  try {
    if (readFileSync(join(commonDir, "info", "grafts")).length > 0) {
      fail("release source inventory refuses a non-empty Git grafts file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseIdentity(value, label, commit) {
  const match = value.match(/^(?<name>.*) <(?<email>[^>]*)> (?<timestamp>\d+) [+-]\d{4}$/);
  if (!match?.groups) {
    fail(`commit ${commit} has a malformed ${label} header`);
  }
  return {
    email: match.groups.email,
    name: match.groups.name,
    timestamp: Number(match.groups.timestamp) * 1000,
  };
}

function parseRawCommit(commit, content) {
  const separator = content.indexOf("\n\n");
  if (separator < 0) {
    fail(`commit ${commit} has malformed raw content`);
  }
  const headerLines = content.slice(0, separator).split("\n");
  const headers = [];
  for (const line of headerLines) {
    if (line.startsWith(" ")) {
      if (headers.length === 0) {
        fail(`commit ${commit} has malformed continued headers`);
      }
      headers[headers.length - 1] += `\n${line}`;
    } else {
      headers.push(line);
    }
  }
  const values = (name) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const trees = values("tree");
  const parents = values("parent");
  const authors = values("author");
  const committers = values("committer");
  if (
    trees.length !== 1 ||
    !objectIdPattern.test(trees[0]) ||
    parents.some((parent) => !objectIdPattern.test(parent)) ||
    authors.length !== 1 ||
    committers.length !== 1
  ) {
    fail(`commit ${commit} has malformed raw topology or identity headers`);
  }
  const message = content.slice(separator + 2);
  const [subject = ""] = message.split(/\r?\n/, 1);
  const firstLineEnd = message.indexOf("\n");
  const body = firstLineEnd < 0 ? "" : message.slice(firstLineEnd + 1).trimStart();
  return {
    author: parseIdentity(authors[0], "author", commit),
    body,
    commit,
    committer: parseIdentity(committers[0], "committer", commit),
    message,
    parents,
    subject,
    tree: trees[0],
  };
}

function readCommitBatch(cwd, commits) {
  if (commits.length === 0) {
    return new Map();
  }
  const output = gitBuffer(cwd, ["cat-file", "--batch"], {
    input: Buffer.from(`${commits.join("\n")}\n`),
  });
  const records = new Map();
  let offset = 0;
  for (const requested of commits) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      fail(`git cat-file omitted commit ${requested}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = header.match(/^(?<commit>[0-9a-f]{40}) (?<type>\S+) (?<size>\d+)$/);
    if (!match?.groups || match.groups.commit !== requested || match.groups.type !== "commit") {
      fail(`git cat-file could not read commit ${requested}`);
    }
    const size = Number(match.groups.size);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      fail(`git cat-file returned an invalid size for commit ${requested}`);
    }
    const content = output.subarray(contentStart, contentEnd).toString("utf8");
    records.set(requested, parseRawCommit(requested, content));
    offset = contentEnd + 1;
  }
  return records;
}

function readRawClosure(cwd, tips) {
  const records = new Map();
  const prime = git(cwd, ["rev-list", ...tips])
    .trim()
    .split("\n")
    .filter(Boolean);
  let pending = [...new Set([...tips, ...prime])];
  while (pending.length > 0) {
    const batch = pending.filter((commit) => !records.has(commit)).toSorted();
    if (batch.length === 0) {
      break;
    }
    const loaded = readCommitBatch(cwd, batch);
    for (const [commit, record] of loaded) {
      records.set(commit, record);
    }
    pending = [...loaded.values()].flatMap((record) => record.parents);
  }
  return records;
}

function ancestorsOf(graph, tip) {
  const ancestors = new Set();
  const pending = [tip];
  while (pending.length > 0) {
    const commit = pending.pop();
    if (ancestors.has(commit)) {
      continue;
    }
    const record = graph.get(commit);
    if (!record) {
      fail(`raw Git graph is missing commit ${commit}`);
    }
    ancestors.add(commit);
    pending.push(...record.parents);
  }
  return ancestors;
}

function rawMergeBase(graph, left, right) {
  const leftAncestors = ancestorsOf(graph, left);
  const rightAncestors = ancestorsOf(graph, right);
  const common = new Set([...leftAncestors].filter((commit) => rightAncestors.has(commit)));
  const commonChildren = new Set();
  for (const commit of common) {
    for (const parent of graph.get(commit).parents) {
      if (common.has(parent)) {
        commonChildren.add(parent);
      }
    }
  }
  const mergeBases = [...common].filter((commit) => !commonChildren.has(commit)).toSorted();
  if (mergeBases.length !== 1) {
    fail(`${left} and ${right} have ${mergeBases.length} raw merge bases`);
  }
  return mergeBases[0];
}

function oldestFirst(graph, commits) {
  const members = new Set(commits);
  const children = new Map();
  const parentCounts = new Map();
  for (const commit of members) {
    const parents = graph.get(commit).parents.filter((parent) => members.has(parent));
    parentCounts.set(commit, parents.length);
    for (const parent of parents) {
      const values = children.get(parent) ?? [];
      values.push(commit);
      children.set(parent, values);
    }
  }
  const compare = (left, right) =>
    graph.get(left).committer.timestamp - graph.get(right).committer.timestamp ||
    left.localeCompare(right);
  const ready = [...members].filter((commit) => parentCounts.get(commit) === 0).sort(compare);
  const ordered = [];
  while (ready.length > 0) {
    const commit = ready.shift();
    ordered.push(commit);
    for (const child of children.get(commit) ?? []) {
      const remaining = parentCounts.get(child) - 1;
      parentCounts.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== members.size) {
    fail("raw Git graph contains a cycle");
  }
  return ordered;
}

function localReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const repository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!repository || repository === "openclaw/openclaw") {
      references.push(Number(match.groups.number));
    }
  }
  return [...new Set(references)];
}

export function explicitPullRequestReferences(subject, body) {
  const references = [];
  const trailing = subject.match(/\((?:(?:openclaw\/openclaw)?#(?<number>\d+))\)\s*$/i);
  if (trailing?.groups?.number) {
    references.push(Number(trailing.groups.number));
  }
  const merge = subject.match(/^Merge pull request #(?<number>\d+)\b/i);
  if (merge?.groups?.number) {
    references.push(Number(merge.groups.number));
  }
  if (/^Reapply\s+"/i.test(subject)) {
    references.push(...localReferencesIn(subject));
  }
  const referenceList = String.raw`(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*`;
  const directive = new RegExp(
    String.raw`^(?:(?:pull request|pr|source-pr|cherry-pick(?:ed)? from)\s*:?\s*${referenceList}|backport(?:ed)? (?:from|of)\s+${referenceList}(?:\s+to\s+\S+)?)\s*[.!]?$`,
    "i",
  );
  for (const line of body.split(/\r?\n/).map((value) => value.trim())) {
    if (directive.test(line)) {
      references.push(...localReferencesIn(line));
    }
  }
  return [...new Set(references)].toSorted((left, right) => left - right);
}

function cherryPickOrigins(message) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function revertedCommit(message) {
  return message.trimStart().match(/^This reverts commit ([0-9a-f]{40})\.(?:\r?\n|$)/i)?.[1];
}

function commitPatch(cwd, graph, commit) {
  const record = graph.get(commit);
  if (!record || record.parents.length !== 1) {
    return undefined;
  }
  const patch = git(cwd, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    record.parents[0],
    commit,
    "--",
  ]);
  if (patch === "") {
    return undefined;
  }
  const patchId = git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0];
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: record.parents[0],
    patch,
    patchId,
  };
}

function patchProducesTree(cwd, patch, parent, expectedTree) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  try {
    execFileSync("git", ["read-tree", parent], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const applied = spawnSync(
      "git",
      ["apply", "--cached", "--3way", "--binary", "--whitespace=nowarn", "-"],
      {
        cwd,
        encoding: "utf8",
        env: environment,
        input: patch,
        maxBuffer,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (applied.status !== 0) {
      return false;
    }
    return (
      execFileSync("git", ["write-tree"], {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === expectedTree
    );
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function exactPatchEquivalent(cwd, graph, left, right, { inverse = false } = {}) {
  const leftPatch = commitPatch(cwd, graph, left);
  const rightPatch = commitPatch(cwd, graph, right);
  const leftRecord = graph.get(left);
  const rightRecord = graph.get(right);
  if (!leftPatch || !rightPatch || !leftRecord || !rightRecord) {
    return false;
  }
  if (inverse) {
    return (
      patchProducesTree(cwd, leftPatch.patch, right, graph.get(rightPatch.parent).tree) &&
      patchProducesTree(cwd, rightPatch.patch, left, graph.get(leftPatch.parent).tree)
    );
  }
  if (leftPatch.patchId !== rightPatch.patchId) {
    return false;
  }
  return (
    patchProducesTree(cwd, leftPatch.patch, rightPatch.parent, rightRecord.tree) &&
    patchProducesTree(cwd, rightPatch.patch, leftPatch.parent, leftRecord.tree)
  );
}

function normalizeAssociationMap(pullRequests, commits, label) {
  if (!(pullRequests instanceof Map)) {
    fail(`association resolver did not return a ${label} map`);
  }
  const normalized = new Map();
  for (const commit of commits) {
    if (!pullRequests.has(commit)) {
      fail(`${label} association evidence is missing commit ${commit}`);
    }
    const numbers = pullRequests.get(commit);
    if (
      !Array.isArray(numbers) ||
      numbers.some((number) => !Number.isInteger(number) || number <= 0)
    ) {
      fail(`association evidence for commit ${commit} is invalid`);
    }
    normalized.set(
      commit,
      [...new Set(numbers)].toSorted((left, right) => left - right),
    );
  }
  return normalized;
}

function normalizeAssociations(result, commits) {
  if (result instanceof Map) {
    const pullRequests = normalizeAssociationMap(result, commits, "included");
    return { allPullRequests: pullRequests, pullRequests };
  }
  return {
    allPullRequests: normalizeAssociationMap(result?.allPullRequests, commits, "complete"),
    pullRequests: normalizeAssociationMap(result?.pullRequests, commits, "included"),
  };
}

function normalizePullRequestEvidence(result, numbers) {
  if (!(result instanceof Map)) {
    fail("pull request evidence resolver did not return a map");
  }
  const normalized = new Map();
  for (const number of numbers) {
    if (!result.has(number)) {
      fail(`pull request evidence is missing #${number}`);
    }
    const node = result.get(number);
    if (node === null) {
      normalized.set(number, null);
      continue;
    }
    if (
      !node ||
      (node.__typename !== "Issue" && node.__typename !== "PullRequest") ||
      node.number !== number ||
      (node.__typename === "PullRequest" &&
        node.mergedAt !== null &&
        typeof node.mergedAt !== "string")
    ) {
      fail(`pull request evidence for #${number} is invalid`);
    }
    normalized.set(number, node);
  }
  return normalized;
}

function activeCommitsAfterReverts(commits, edges) {
  const members = new Set(commits);
  const revertsByTarget = new Map();
  for (const edge of edges) {
    if (!members.has(edge.revertCommit) || !members.has(edge.targetCommit)) {
      continue;
    }
    const reverts = revertsByTarget.get(edge.targetCommit) ?? [];
    reverts.push(edge.revertCommit);
    revertsByTarget.set(edge.targetCommit, reverts);
  }
  const active = new Map();
  function isActive(commit, seen = new Set()) {
    if (active.has(commit)) {
      return active.get(commit);
    }
    if (seen.has(commit)) {
      fail(`cyclic revert graph at ${commit}`);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(commit);
    const value = !(revertsByTarget.get(commit) ?? []).some((revert) => isActive(revert, nextSeen));
    active.set(commit, value);
    return value;
  }
  return new Set([...members].filter((commit) => isActive(commit)));
}

function revertLineage(graph, start) {
  const commits = [];
  const seen = new Set();
  let current = start;
  while (graph.has(current)) {
    if (seen.has(current)) {
      fail(`cyclic revert lineage at ${current}`);
    }
    seen.add(current);
    commits.push(current);
    const target = revertedCommit(graph.get(current).body);
    if (!target) {
      break;
    }
    current = target;
  }
  return commits;
}

function setSummary(values, compare = (left, right) => String(left).localeCompare(String(right))) {
  const members = [...new Set(values)].sort(compare);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(`${JSON.stringify(members)}\n`)
      .digest("hex"),
  };
}

function digestInventory(inventory) {
  return createHash("sha256")
    .update(`${JSON.stringify(inventory)}\n`)
    .digest("hex");
}

function changedPaths(cwd, parent, commit) {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", parent, commit, "--"])
    .split("\0")
    .filter(Boolean)
    .toSorted();
}

function mergeResolutionDigest(cwd, commit) {
  const diff = git(cwd, [
    "show",
    "--remerge-diff",
    "--format=",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    commit,
    "--",
  ]);
  return diff === "" ? undefined : createHash("sha256").update(diff).digest("hex");
}

export function buildReleaseSourceInventory(
  {
    baseRef,
    cwd = process.cwd(),
    finalTargetRef,
    provenanceRefs = [],
    repository = "openclaw/openclaw",
    shippedRefs = [],
    sourceTargetRef,
  },
  { resolveAssociations, resolvePullRequests },
) {
  assertCanonicalRepository(cwd);
  const base = resolveCommit(cwd, baseRef);
  const sourceTarget = resolveCommit(cwd, sourceTargetRef);
  const finalTarget = resolveCommit(cwd, finalTargetRef ?? sourceTargetRef);
  const shipped = shippedRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const provenance = provenanceRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const graph = readRawClosure(cwd, [
    base,
    sourceTarget,
    finalTarget,
    ...shipped.map((entry) => entry.commit),
    ...provenance.map((entry) => entry.commit),
  ]);
  const mergeBase = rawMergeBase(graph, base, sourceTarget);
  const boundaryAncestors = ancestorsOf(graph, mergeBase);
  const sourceAncestors = ancestorsOf(graph, sourceTarget);
  const sourceCommits = oldestFirst(
    graph,
    [...sourceAncestors].filter((commit) => !boundaryAncestors.has(commit)),
  );
  const targetTimestamp = graph.get(sourceTarget).committer.timestamp;
  const sourceOrigins = [
    ...new Set(sourceCommits.flatMap((commit) => cherryPickOrigins(graph.get(commit).body))),
  ];
  if (sourceOrigins.length > 0) {
    const originGraph = readRawClosure(cwd, sourceOrigins);
    for (const [commit, record] of originGraph) {
      graph.set(commit, record);
    }
  }
  const provenanceExclusive = [
    ...new Set(
      provenance.flatMap((entry) =>
        [...ancestorsOf(graph, entry.commit)].filter((commit) => !sourceAncestors.has(commit)),
      ),
    ),
  ];
  const provenanceCandidates = provenanceExclusive.filter((commit) => {
    const record = graph.get(commit);
    return record.parents.length === 1 && record.committer.timestamp <= targetTimestamp;
  });
  const externalRevertLineage = [
    ...new Set(
      sourceCommits.flatMap((commit) => {
        const target = revertedCommit(graph.get(commit).body);
        return target ? revertLineage(graph, target) : [];
      }),
    ),
  ];
  const shippedExclusiveByRef = shipped.map((entry) => ({
    ...entry,
    commits: [...ancestorsOf(graph, entry.commit)].filter((commit) => !sourceAncestors.has(commit)),
    mergeBase: rawMergeBase(graph, entry.commit, sourceTarget),
  }));
  const associationCommits = [
    ...new Set([
      ...sourceCommits,
      ...sourceOrigins,
      ...provenanceCandidates,
      ...externalRevertLineage,
      ...shippedExclusiveByRef.flatMap((entry) => entry.commits),
      ...(finalTarget === sourceTarget ? [] : [finalTarget]),
    ]),
  ].toSorted();
  const associationEvidence = normalizeAssociations(
    resolveAssociations(associationCommits, graph.get(sourceTarget).committer.timestamp),
    associationCommits,
  );
  const associations = associationEvidence.pullRequests;
  const allAssociations = associationEvidence.allPullRequests;

  let sourceTail;
  if (finalTarget !== sourceTarget) {
    const finalRecord = graph.get(finalTarget);
    const paths = changedPaths(cwd, sourceTarget, finalTarget);
    const explicit = explicitPullRequestReferences(finalRecord.subject, finalRecord.body);
    const origins = cherryPickOrigins(finalRecord.body);
    if (
      finalRecord.parents.length !== 1 ||
      finalRecord.parents[0] !== sourceTarget ||
      paths.length !== 1 ||
      paths[0] !== "CHANGELOG.md" ||
      allAssociations.get(finalTarget).length > 0 ||
      explicit.length > 0 ||
      origins.length > 0 ||
      localReferencesIn(finalRecord.message).length > 0
    ) {
      fail(
        `final target ${finalTarget} must be one association-free, reference-free CHANGELOG.md-only child of ${sourceTarget}`,
      );
    }
    sourceTail = {
      commit: finalTarget,
      parent: sourceTarget,
      paths,
      subject: finalRecord.subject,
      tree: finalRecord.tree,
    };
  }

  const sourceRecords = sourceCommits.map((commit, topoIndex) => {
    const record = graph.get(commit);
    return {
      ...record,
      associatedPullRequests: associations.get(commit),
      cherryPickOrigins: cherryPickOrigins(record.body),
      explicitPullRequestReferences: explicitPullRequestReferences(record.subject, record.body),
      references: localReferencesIn(record.message),
      revertedExternalPullRequests: [],
      revertedExternalReferences: [],
      topoIndex,
    };
  });
  const explicitNumbers = [
    ...new Set(sourceRecords.flatMap((record) => record.explicitPullRequestReferences)),
  ].toSorted((left, right) => left - right);
  if (explicitNumbers.length > 0 && typeof resolvePullRequests !== "function") {
    fail("release source inventory requires a pull request evidence resolver");
  }
  const explicitPullRequests =
    explicitNumbers.length === 0
      ? new Map()
      : normalizePullRequestEvidence(resolvePullRequests(explicitNumbers), explicitNumbers);
  const patchCache = new Map();
  const patchFor = (commit) => {
    if (!patchCache.has(commit)) {
      patchCache.set(commit, commitPatch(cwd, graph, commit));
    }
    return patchCache.get(commit);
  };
  const unresolved = [];
  const revertEdges = [];
  const sourceCommitSet = new Set(sourceCommits);
  const externalRevertStates = new Map();

  function externalRevertState(commit, seen = new Set()) {
    if (externalRevertStates.has(commit)) {
      return externalRevertStates.get(commit);
    }
    if (seen.has(commit)) {
      return { reason: `cyclic external revert lineage at ${commit}` };
    }
    const record = graph.get(commit);
    if (!record) {
      return { reason: `external revert target ${commit} is unavailable` };
    }
    const target = revertedCommit(record.body);
    if (!target) {
      if (record.subject.startsWith('Revert "')) {
        return {
          reason: `external revert ${commit} is missing a canonical full-SHA trailer`,
        };
      }
      const state = {
        depth: 0,
        pullRequests: associations.get(commit) ?? [],
        references: localReferencesIn(record.message),
        rootCommit: commit,
      };
      externalRevertStates.set(commit, state);
      return state;
    }
    const targetRecord = graph.get(target);
    if (
      record.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      !ancestorsOf(graph, record.parents[0]).has(target) ||
      !exactPatchEquivalent(cwd, graph, target, commit, { inverse: true })
    ) {
      return {
        reason: `external revert ${commit} does not exactly invert ancestor ${target}`,
      };
    }
    const targetState = externalRevertState(target, new Set([...seen, commit]));
    if (targetState.reason) {
      return targetState;
    }
    const state = { ...targetState, depth: targetState.depth + 1 };
    externalRevertStates.set(commit, state);
    return state;
  }

  for (const record of sourceRecords) {
    const target = revertedCommit(record.body);
    if (!target) {
      if (record.subject.startsWith('Revert "')) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: "revert subject is missing a canonical full-SHA trailer",
        });
      }
      continue;
    }
    const targetRecord = graph.get(target);
    const parent = record.parents[0];
    if (
      record.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      !ancestorsOf(graph, parent).has(target) ||
      !exactPatchEquivalent(cwd, graph, target, record.commit, { inverse: true })
    ) {
      unresolved.push({
        commit: record.commit,
        kind: "revert",
        reason: `revert does not exactly invert ancestor ${target}`,
      });
      continue;
    }
    revertEdges.push({ revertCommit: record.commit, targetCommit: target });
    if (!sourceCommitSet.has(target)) {
      const state = externalRevertState(target);
      if (state.reason) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: state.reason,
        });
      } else if (state.depth % 2 === 0) {
        record.revertedExternalPullRequests = state.pullRequests;
        record.revertedExternalReferences = state.references;
      }
    }
  }
  const active = activeCommitsAfterReverts(sourceCommits, revertEdges);

  const associatedProvenanceCandidates = provenanceCandidates.filter(
    (commit) => associations.get(commit).length > 0,
  );
  const provenanceByPatch = new Map();
  for (const commit of associatedProvenanceCandidates) {
    const patch = patchFor(commit);
    if (!patch?.patchId) {
      continue;
    }
    const values = provenanceByPatch.get(patch.patchId) ?? [];
    values.push(commit);
    provenanceByPatch.set(patch.patchId, values);
  }

  const ownership = new Map();
  for (const record of sourceRecords) {
    const evidence = [];
    for (const number of record.associatedPullRequests) {
      evidence.push({ method: "association", number, sourceCommit: record.commit });
    }
    for (const number of record.explicitPullRequestReferences) {
      const node = explicitPullRequests.get(number);
      const mergedAt =
        node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
          ? Date.parse(node.mergedAt)
          : Number.NaN;
      if (
        node?.__typename !== "PullRequest" ||
        !Number.isFinite(mergedAt) ||
        mergedAt > targetTimestamp
      ) {
        unresolved.push({
          commit: record.commit,
          kind: "ownership",
          pullRequests: [number],
          reason: `strict ownership reference #${number} is not a merged pull request by the source target cutoff`,
        });
        continue;
      }
      evidence.push({ method: "explicit-reference", number, sourceCommit: record.commit });
    }
    for (const origin of record.cherryPickOrigins) {
      const originRecord = graph.get(origin);
      if (!originRecord || !exactPatchEquivalent(cwd, graph, record.commit, origin)) {
        unresolved.push({
          commit: record.commit,
          kind: "cherry-pick",
          reason: `cherry-pick origin ${origin} is unavailable or not exactly equivalent`,
        });
        continue;
      }
      for (const number of associations.get(origin) ?? []) {
        evidence.push({ method: "cherry-origin-association", number, sourceCommit: origin });
      }
    }
    const patch = patchFor(record.commit);
    const trustedCandidates = (provenanceByPatch.get(patch?.patchId) ?? []).filter((candidate) =>
      exactPatchEquivalent(cwd, graph, record.commit, candidate),
    );
    for (const candidate of trustedCandidates) {
      for (const number of associations.get(candidate) ?? []) {
        evidence.push({
          method: "trusted-patch-association",
          number,
          sourceCommit: candidate,
        });
      }
    }
    const pullRequests = [...new Set(evidence.map((entry) => entry.number))].toSorted(
      (left, right) => left - right,
    );
    if (pullRequests.length > 1) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests,
        reason: "ownership evidence resolves to more than one pull request",
      });
      continue;
    }
    if (record.cherryPickOrigins.length > 0 && pullRequests.length === 0) {
      unresolved.push({
        commit: record.commit,
        kind: "cherry-pick",
        reason: "verified cherry-pick provenance did not resolve one pull request",
      });
      continue;
    }
    ownership.set(record.commit, {
      evidence: evidence.filter((entry) => entry.number === pullRequests[0]),
      pullRequests,
    });
  }

  const shippedMatches = new Map();
  for (const baseline of shippedExclusiveByRef) {
    const baselineEdges = [];
    for (const commit of baseline.commits) {
      const record = graph.get(commit);
      const target = revertedCommit(record.body);
      if (!target) {
        if (record.subject.startsWith('Revert "')) {
          fail(
            `shipped baseline ${baseline.ref} revert ${commit} is missing a canonical full-SHA trailer`,
          );
        }
        continue;
      }
      if (!baseline.commits.includes(target)) {
        continue;
      }
      const targetRecord = graph.get(target);
      const parent = record.parents[0];
      if (
        record.parents.length !== 1 ||
        !targetRecord ||
        targetRecord.parents.length !== 1 ||
        !ancestorsOf(graph, parent).has(target) ||
        !exactPatchEquivalent(cwd, graph, target, commit, { inverse: true })
      ) {
        fail(`shipped baseline ${baseline.ref} revert ${commit} does not exactly invert ${target}`);
      }
      baselineEdges.push({ revertCommit: commit, targetCommit: target });
    }
    const activeBaselineCommits = activeCommitsAfterReverts(baseline.commits, baselineEdges);
    const byPatch = new Map();
    for (const commit of activeBaselineCommits) {
      const patch = patchFor(commit);
      if (!patch?.patchId) {
        continue;
      }
      const values = byPatch.get(patch.patchId) ?? [];
      values.push(commit);
      byPatch.set(patch.patchId, values);
    }
    for (const record of sourceRecords) {
      if (!active.has(record.commit) || record.parents.length !== 1) {
        continue;
      }
      const patch = patchFor(record.commit);
      const matches = (byPatch.get(patch?.patchId) ?? []).filter((candidate) =>
        exactPatchEquivalent(cwd, graph, record.commit, candidate),
      );
      if (matches.length > 0) {
        const values = shippedMatches.get(record.commit) ?? [];
        values.push({
          commits: matches.toSorted(),
          ref: baseline.ref,
        });
        shippedMatches.set(record.commit, values);
      }
    }
  }

  const commits = [];
  for (const record of sourceRecords) {
    const owner = ownership.get(record.commit) ?? { evidence: [], pullRequests: [] };
    let disposition;
    let mergeResolution;
    if (unresolved.some((entry) => entry.commit === record.commit)) {
      disposition = "unresolved";
    } else if (!active.has(record.commit)) {
      disposition = "reverted";
    } else if (shippedMatches.has(record.commit)) {
      disposition = "shipped";
    } else if (owner.pullRequests.length === 1) {
      disposition = "pull-request";
    } else if (record.parents.length > 1) {
      mergeResolution = mergeResolutionDigest(cwd, record.commit);
      if (record.parents.length === 2 && !mergeResolution) {
        disposition = "structural-merge";
      } else {
        disposition = "unresolved";
        unresolved.push({
          commit: record.commit,
          kind: "merge-resolution",
          reason:
            record.parents.length > 2
              ? "octopus merge requires reviewed provenance"
              : "merge resolution content has no singular ownership",
        });
      }
    } else {
      disposition = "direct";
    }
    const patch = record.parents.length === 1 ? patchFor(record.commit) : undefined;
    commits.push({
      associatedPullRequests: record.associatedPullRequests,
      authorEmail: record.author.email,
      authorName: record.author.name,
      body: record.body,
      cherryPickOrigins: record.cherryPickOrigins,
      commit: record.commit,
      diffSha256: patch?.diffSha256,
      disposition,
      evidence: owner.evidence,
      explicitPullRequestReferences: record.explicitPullRequestReferences,
      mergeResolutionDiffSha256: mergeResolution,
      parents: record.parents,
      patchId: patch?.patchId,
      pullRequests: owner.pullRequests,
      references: record.references,
      shippedEvidence: shippedMatches.get(record.commit) ?? [],
      subject: record.subject,
      topoIndex: record.topoIndex,
      tree: record.tree,
    });
  }

  const includedPullRequests = commits
    .filter((commit) => commit.disposition === "pull-request")
    .flatMap((commit) => commit.pullRequests);
  const shippedPullRequests = commits
    .filter((commit) => commit.disposition === "shipped")
    .flatMap((commit) => commit.pullRequests);
  const revertedPullRequests = commits
    .filter((commit) => commit.disposition === "reverted")
    .flatMap((commit) => commit.pullRequests);
  const directCommits = commits
    .filter((commit) => commit.disposition === "direct")
    .map((commit) => commit.commit);
  const structuralMerges = commits
    .filter((commit) => commit.disposition === "structural-merge")
    .map((commit) => commit.commit);
  const shippedCommits = commits
    .filter((commit) => commit.disposition === "shipped")
    .map((commit) => commit.commit);
  const revertedCommits = commits
    .filter((commit) => commit.disposition === "reverted")
    .map((commit) => commit.commit);
  const unresolvedCommits = commits
    .filter((commit) => commit.disposition === "unresolved")
    .map((commit) => commit.commit);
  const partitions = {
    commits: {
      direct: setSummary(directCommits),
      pullRequest: setSummary(
        commits
          .filter((commit) => commit.disposition === "pull-request")
          .map((commit) => commit.commit),
      ),
      reverted: setSummary(revertedCommits),
      shipped: setSummary(shippedCommits),
      structuralMerge: setSummary(structuralMerges),
      unresolved: setSummary(unresolvedCommits),
      universe: setSummary(sourceCommits),
    },
    pullRequests: {
      included: setSummary(includedPullRequests, (left, right) => left - right),
      reverted: setSummary(revertedPullRequests, (left, right) => left - right),
      shipped: setSummary(shippedPullRequests, (left, right) => left - right),
    },
  };
  const covered =
    partitions.commits.direct.count +
    partitions.commits.pullRequest.count +
    partitions.commits.reverted.count +
    partitions.commits.shipped.count +
    partitions.commits.structuralMerge.count +
    partitions.commits.unresolved.count;
  if (covered !== partitions.commits.universe.count) {
    fail(
      `release source inventory partition covers ${covered} of ${partitions.commits.universe.count} commits`,
    );
  }
  const inventory = {
    complete: unresolved.length === 0,
    commits,
    partitions,
    range: {
      base: { commit: base, ref: baseRef },
      finalTarget,
      mergeBase,
      provenance,
      shipped: shippedExclusiveByRef.map(({ commit, mergeBase: baselineMergeBase, ref }) => ({
        commit,
        mergeBase: baselineMergeBase,
        ref,
      })),
      sourceTarget,
      sourceTail,
      targetTimestamp,
    },
    repository,
    schemaVersion: 1,
    unresolved: unresolved.toSorted(
      (left, right) =>
        left.commit.localeCompare(right.commit) || left.kind.localeCompare(right.kind),
    ),
  };
  return { ...inventory, sha256: digestInventory(inventory) };
}

export function assertCompleteReleaseSourceInventory(inventory) {
  if (!inventory?.complete || inventory.unresolved?.length > 0) {
    const reasons = (inventory?.unresolved ?? [])
      .map((entry) => `${entry.commit}: ${entry.reason}`)
      .join("\n");
    fail(`release source inventory is incomplete${reasons ? `:\n${reasons}` : ""}`);
  }
  return inventory;
}
