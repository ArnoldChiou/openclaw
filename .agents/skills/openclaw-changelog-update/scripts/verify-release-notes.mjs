#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  extractChangelogReleaseSections,
  formatShippedBaselineExclusions,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  verifyGithubReleaseNotes,
} from "../../../../scripts/render-github-release-notes.mjs";
import {
  assertCompleteReleaseSourceInventory,
  buildReleaseSourceInventory,
  canonicalGitEnvironment,
} from "./lib/release-source-inventory.mjs";

const repo = "openclaw/openclaw";
const commitAssociationQueryBatchSize = 20;
const excludedHandles = new Set(["openclaw", "clawsweeper", "claude", "codex", "steipete"]);
const nonEditorialTypes = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "qa",
  "refactor",
  "style",
  "test",
]);
const nonEditorialTitlePattern =
  /(?:^|[\s:([{\-])(docs?|documentation|tests?|testing|qa|quality assurance|refactor(?:ing)?|ci|continuous integration|build|chore|style|lint|format)(?:$|[\s:)\]}\-])/i;
const editorialTitlePattern =
  /^\s*(?:\[[^\]]+\]\s*)?(?:#\d+:\s*)?(?:add|allow|block|enable|expose|fail|fix|harden|honor|improve|keep|migrate|move|persist|polish|preserve|prevent|propagate|rate[- ]?limit|restore|revert|ship|support|treat|validate)\b|^\s*#\d+:/i;
const genericDirectCommitTerms = new Set([
  "add",
  "allow",
  "avoid",
  "build",
  "change",
  "fix",
  "improve",
  "keep",
  "make",
  "missing",
  "move",
  "omit",
  "omitted",
  "prevent",
  "repair",
  "required",
  "restore",
  "update",
]);

function fail(message) {
  throw new Error(message);
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \\
    --base <tag-or-sha> --target <tag-or-sha> --version <version> [options]

Required:
  --base <ref>          Release range start.
  --target <ref>        Release range end.
  --version <version>   CHANGELOG.md version heading to verify.

Options:
  --manifest <path>     Read or write the complete contribution record ledger.
  --seed-ref <ref>      Use an existing release section as editorial input.
  --shipped-ref <tag>   Exclude PRs already recorded by this shipped tag; repeatable.
  --source-target <ref> Inventory cutoff; --target may be one final CHANGELOG-only child.
  --provenance-ref <ref>
                        Search this trusted ref for unique cherry-pick provenance; repeatable.
  --write-ledger        Write the verified ledger back into CHANGELOG.md.
  --release-tag <tag>   GitHub release tag to compare; repeatable with --check-github.
  --check-github        Require each supplied GitHub release body to match.
  --json                Emit machine-readable verification output.
  --help                Show this help text.`);
}

function parseArgs(argv) {
  const options = {
    releaseTags: [],
    checkGithub: false,
    help: false,
    json: false,
    manifestPath: undefined,
    provenanceRefs: [],
    seedRef: undefined,
    shippedRefs: [],
    writeLedger: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--check-github" || arg === "--json" || arg === "--write-ledger") {
      options[
        arg === "--check-github" ? "checkGithub" : arg === "--write-ledger" ? "writeLedger" : "json"
      ] = true;
      continue;
    }
    if (
      arg === "--base" ||
      arg === "--target" ||
      arg === "--version" ||
      arg === "--release-tag" ||
      arg === "--shipped-ref" ||
      arg === "--source-target" ||
      arg === "--provenance-ref" ||
      arg === "--manifest" ||
      arg === "--seed-ref"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      if (arg === "--release-tag") {
        options.releaseTags.push(value);
      } else if (arg === "--shipped-ref") {
        options.shippedRefs.push(value);
      } else if (arg === "--source-target") {
        options.sourceTarget = value;
      } else if (arg === "--provenance-ref") {
        options.provenanceRefs.push(value);
      } else if (arg === "--manifest") {
        options.manifestPath = value;
      } else if (arg === "--seed-ref") {
        options.seedRef = value;
      } else {
        options[arg.slice(2)] = value;
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!options.help) {
    for (const name of ["base", "target", "version"]) {
      if (!options[name]) {
        fail(`--${name} is required`);
      }
    }
  } else if (options.checkGithub || options.releaseTags.length > 0) {
    fail("--help cannot be combined with verification options");
  }
  if (!options.help && options.checkGithub && options.releaseTags.length === 0) {
    fail("--check-github requires at least one --release-tag");
  }
  const uniqueShippedRefs = new Set(options.shippedRefs);
  if (uniqueShippedRefs.size !== options.shippedRefs.length) {
    fail("--shipped-ref values must be unique");
  }
  options.shippedRefs = options.shippedRefs.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const uniqueProvenanceRefs = new Set(options.provenanceRefs);
  if (uniqueProvenanceRefs.size !== options.provenanceRefs.length) {
    fail("--provenance-ref values must be unique");
  }
  options.provenanceRefs = options.provenanceRefs.toSorted((a, b) =>
    a === b ? 0 : a < b ? -1 : 1,
  );
  return options;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: command === "git" ? canonicalGitEnvironment() : { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args) {
  return run("git", args).trimEnd();
}

function gitIsAncestor(base, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${base}^{commit}`, `${target}^{commit}`],
    {
      encoding: "utf8",
      env: canonicalGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  fail(
    `could not validate release range ancestry for ${base}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function githubApi(args) {
  try {
    return JSON.parse(run("ghx", ["api", ...args]).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ""));
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return JSON.parse(error.stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ""));
    }
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEligibleHandle(handle) {
  return (
    typeof handle === "string" &&
    handle.toLowerCase() !== "undefined" &&
    !handle.endsWith("[bot]") &&
    !excludedHandles.has(handle.toLowerCase())
  );
}

function githubHandleFromNoreply(email) {
  return email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[1];
}

function editorialClassification(subject) {
  const type = subject.match(/^\s*([a-z]+)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
  return {
    editorialEligible:
      (Boolean(type) || editorialTitlePattern.test(subject)) &&
      !nonEditorialTypes.has(type) &&
      !nonEditorialTitlePattern.test(subject),
    type: type ?? "other",
  };
}

function mergedByTarget(mergedAt, targetTimestamp) {
  const mergedTimestamp = Date.parse(mergedAt);
  return Number.isFinite(mergedTimestamp) && mergedTimestamp <= targetTimestamp;
}

function sectionFor(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\r?$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  const start = heading.index;
  const bodyStart = changelog.indexOf("\n", start) + 1;
  const next = /^## /gm;
  next.lastIndex = bodyStart;
  const nextHeading = next.exec(changelog);
  const end = nextHeading?.index ?? changelog.length;
  return {
    start,
    end,
    source: changelog.slice(start, end).trimEnd(),
    body: changelog.slice(bodyStart, end).trim(),
  };
}

function referencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!qualifiedRepository || qualifiedRepository === repo) {
      references.push(Number(match.groups?.number));
    }
  }
  return references;
}

function referenceLabelsIn(text) {
  const labels = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`
      : undefined;
    labels.push(
      !qualifiedRepository || qualifiedRepository.toLowerCase() === repo
        ? `#${match.groups?.number}`
        : `${qualifiedRepository}#${match.groups?.number}`,
    );
  }
  return labels;
}

export function renderContributionRecordEntry(entry) {
  const references = [];
  appendUnique(references, referenceLabelsIn(entry.title));
  appendUnique(
    references,
    (entry.priorReferences ?? []).map((number) => `#${number}`),
  );
  appendUnique(references, entry.externalReferences ?? []);
  for (const issue of entry.linkedIssues) {
    appendUnique(references, [`#${issue.number}`]);
  }
  const related = references.length > 0 ? ` Related ${references.join(", ")}.` : "";
  const attribution =
    entry.thanks.length > 0
      ? ` Thanks ${entry.thanks.map((handle) => `@${handle}`).join(" and ")}.`
      : "";
  return `- **PR #${entry.number}**${related}${attribution}`;
}

export function releaseNoteReferences(sectionSource, shippedBaselines) {
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  // The baseline inventory proves subtraction; its PR ids are not release-note references.
  const referenceSource = shippedBaselineLine
    ? sectionSource.replace(shippedBaselineLine, "")
    : sectionSource;
  return referencesIn(referenceSource);
}

function closingReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /\b(?:fix(?:es|ed)?|closes?|closed|resolves?|resolved)\s+(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*/gi,
  )) {
    appendReferences(references, referencesIn(match[0]));
  }
  return references;
}

function standardRevertedHash(message) {
  return message
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .map((paragraph) => paragraph.match(/^This reverts commit ([0-9a-f]{7,40})\.$/i)?.[1])
    .find(Boolean);
}

function handlesIn(text) {
  const thanksStart = text.lastIndexOf(" Thanks ");
  if (thanksStart < 0) {
    return [];
  }
  const content = text.slice(0, thanksStart);
  return [...text.slice(thanksStart).matchAll(/@([A-Za-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter(
      (handle) =>
        isEligibleHandle(handle) &&
        !new RegExp(`(?<![A-Za-z0-9-])@${escapeRegExp(handle)}\\b`, "i").test(content),
    );
}

function externalReferencesIn(text) {
  return referenceLabelsIn(text).filter((reference) => !reference.startsWith("#"));
}

function appendUnique(values, additions) {
  const seen = new Set(values.map((value) => value.toLowerCase()));
  for (const value of additions) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      values.push(value);
      seen.add(key);
    }
  }
}

function addContributionRecordEntry(entries, key, entry) {
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, {
      ...entry,
      externalReferences: [...(entry.externalReferences ?? [])],
      references: [...entry.references],
      thanks: [...entry.thanks],
    });
    return;
  }
  appendUnique(existing.externalReferences, entry.externalReferences ?? []);
  appendReferences(existing.references, entry.references);
  addHandles(existing.thanks, entry.thanks);
}

export function contributionRecordFor(section) {
  const result = { legacyIssues: new Map(), pullRequests: new Map() };
  const recordStart = section.source.search(/\n### Complete contribution (?:ledger|record)\r?$/m);
  if (recordStart < 0) {
    return result;
  }
  const record = section.source.slice(recordStart);
  let subsection = "";
  for (const line of record.split("\n")) {
    if (line === "#### Pull requests") {
      subsection = "pull-requests";
      continue;
    }
    if (line === "#### Linked issues") {
      subsection = "linked-issues";
      continue;
    }
    if (line.startsWith("#### ")) {
      subsection = "";
      continue;
    }
    if (subsection === "pull-requests") {
      const explicitRecord = line.match(/^- \*\*PR #(\d+)\*\*/);
      const legacyRecord = line.match(/\(#(\d+)\)\.(?: Thanks.*)?$/);
      const number = explicitRecord?.[1] ?? legacyRecord?.[1];
      if (number) {
        const value = Number(number);
        const metadata = explicitRecord ? line.slice(explicitRecord[0].length) : line;
        addContributionRecordEntry(result.pullRequests, value, {
          externalReferences: externalReferencesIn(metadata),
          references: referencesIn(metadata).filter((reference) => reference !== value),
          thanks: handlesIn(line),
        });
      }
      continue;
    }
    if (subsection === "linked-issues") {
      const number = referencesIn(line)[0];
      if (number) {
        addContributionRecordEntry(result.legacyIssues, number, {
          references: [],
          thanks: handlesIn(line),
        });
      }
    }
  }
  return result;
}

function completeContributionRecord(section, label) {
  const recordStart = section.source.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    fail(`${label} is missing ### Complete contribution record`);
  }
  const recordSource = section.source.slice(recordStart);
  const provenance = recordSource.match(
    /^This audited record covers the complete \S+\.\.[0-9a-f]{40} history: (?<count>[0-9]+) merged PRs?\./mu,
  );
  if (!provenance?.groups?.count) {
    fail(`${label} is missing exact complete contribution record provenance`);
  }
  const record = contributionRecordFor(section);
  const declaredCount = Number(provenance.groups.count);
  if (record.pullRequests.size !== declaredCount) {
    fail(
      `${label} contribution record declares ${declaredCount} PRs but contains ${record.pullRequests.size}`,
    );
  }
  return { record, declaredCount };
}

export function cumulativeShippedPullRequests(changelog, label) {
  const sections = extractChangelogReleaseSections(changelog).filter(
    (section) =>
      section.version !== "Unreleased" &&
      section.source.includes("\n### Complete contribution record"),
  );
  if (sections.length === 0) {
    fail(`${label} is missing ### Complete contribution record`);
  }
  const pullRequests = new Set();
  for (const section of sections) {
    const record = contributionRecordFor(section);
    for (const number of record.pullRequests.keys()) {
      pullRequests.add(number);
    }
  }
  return pullRequests;
}

function shippedBaselineFor(ref) {
  const version = releaseNotesVersionForTag(ref);
  const tagRef = `refs/tags/${ref}`;
  git(["rev-parse", `${tagRef}^{commit}`]);
  const changelog = git(["show", `${tagRef}:CHANGELOG.md`]);
  completeContributionRecord(sectionFor(changelog, version), `shipped baseline ${ref}`);
  return {
    ref,
    pullRequests: cumulativeShippedPullRequests(changelog, `shipped baseline ${ref}`),
  };
}

export function subtractShippedPullRequests(source, baselines) {
  const excluded = new Set();
  const metadata = [];
  for (const baseline of baselines.toSorted((a, b) =>
    a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1,
  )) {
    const pullRequests = [];
    for (const number of baseline.pullRequests) {
      if (
        !excluded.has(number) &&
        (source.pullRequests.has(number) || source.references.includes(number))
      ) {
        excluded.add(number);
        pullRequests.push(number);
      }
      source.pullRequests.delete(number);
    }
    source.references = source.references.filter((number) => !baseline.pullRequests.has(number));
    const sortedPullRequests = pullRequests.toSorted((a, b) => a - b);
    metadata.push({
      ref: baseline.ref,
      count: sortedPullRequests.length,
      pullRequests: sortedPullRequests,
    });
  }
  return { baselines: metadata, pullRequests: excluded };
}

export function exactShippedPullRequestExclusions(source, baselines) {
  const included = new Set(source.inventory.partitions.pullRequests.included.members);
  const excluded = new Set(
    source.inventory.partitions.pullRequests.shipped.members.filter(
      (number) => !included.has(number),
    ),
  );
  const claimed = new Set();
  const metadata = baselines
    .toSorted((left, right) => left.ref.localeCompare(right.ref))
    .map((baseline) => {
      const pullRequests = source.inventory.commits
        .filter(
          (commit) =>
            commit.disposition === "shipped" &&
            commit.shippedEvidence.some((evidence) => evidence.ref === baseline.ref),
        )
        .flatMap((commit) => commit.pullRequests)
        .filter((number) => excluded.has(number) && !claimed.has(number));
      const members = [...new Set(pullRequests)].toSorted((left, right) => left - right);
      for (const number of members) {
        claimed.add(number);
      }
      return { count: members.length, pullRequests: members, ref: baseline.ref };
    });
  return { baselines: metadata, pullRequests: excluded };
}

export function withoutExcludedContributionRecords(record, excludedReferences) {
  if (excludedReferences.size === 0) {
    return record;
  }
  const filtered = { legacyIssues: new Map(), pullRequests: new Map() };
  for (const [number, entry] of record.pullRequests) {
    if (excludedReferences.has(number)) {
      continue;
    }
    addContributionRecordEntry(filtered.pullRequests, number, {
      ...entry,
      externalReferences: entry.externalReferences,
      references: entry.references.filter((reference) => !excludedReferences.has(reference)),
    });
  }
  for (const [number, entry] of record.legacyIssues) {
    if (!excludedReferences.has(number)) {
      addContributionRecordEntry(filtered.legacyIssues, number, entry);
    }
  }
  return filtered;
}

function contributionRecordReferences(record) {
  return [...record.pullRequests.keys()];
}

function contributionRecordMetadataReferences(record) {
  const references = contributionRecordReferences(record);
  for (const entry of record.pullRequests.values()) {
    appendReferences(references, entry.references);
  }
  appendReferences(references, record.legacyIssues.keys());
  return references;
}

export function contaminatingPullRequestReferences({
  noteReferences,
  recordedReferences,
  sourcePullRequests,
  seededPullRequests,
  nodes,
}) {
  const allowed = new Set([...sourcePullRequests, ...seededPullRequests]);
  return [...new Set([...noteReferences, ...recordedReferences])].filter(
    (number) => nodes.get(number)?.__typename === "PullRequest" && !allowed.has(number),
  );
}

function appendReferences(references, additions) {
  const seen = new Set(references);
  for (const number of additions) {
    if (!seen.has(number)) {
      references.push(number);
      seen.add(number);
    }
  }
}

function sourceCommits(options) {
  const inventory = assertCompleteReleaseSourceInventory(
    buildReleaseSourceInventory(
      {
        baseRef: options.base,
        finalTargetRef: options.target,
        provenanceRefs: options.provenanceRefs,
        shippedRefs: options.shippedRefs,
        sourceTargetRef: options.sourceTarget ?? options.target,
      },
      {
        resolveAssociations: (commits, targetTimestamp) =>
          resolveAssociatedPullRequests(commits, targetTimestamp),
        resolvePullRequests: (numbers) => {
          const nodes = resolveReferences(numbers);
          return new Map(numbers.map((number) => [number, nodes.get(number) ?? null]));
        },
      },
    ),
  );
  const source = sourceContributionsFromInventory(inventory);
  return sourceContributionsFromInventory(inventory, resolveCommitCoauthors(source.activeCommits));
}

export function sourceContributionsFromInventory(inventory, resolvedCommitCoauthors = new Map()) {
  const activeCommits = [];
  const coauthorsByReference = new Map();
  const references = [];
  const pullRequests = new Set(inventory.partitions.pullRequests.included.members);
  const revertedReferences = new Set();
  for (const commit of inventory.commits) {
    if (commit.disposition === "reverted") {
      for (const number of [...commit.references, ...commit.pullRequests]) {
        revertedReferences.add(number);
      }
      continue;
    }
    if (commit.disposition !== "pull-request" && commit.disposition !== "direct") {
      continue;
    }
    const coauthorEmails = [...commit.body.matchAll(/^Co-authored-by:\s*.+?<([^>\s]+)>$/gim)].map(
      (match) => match[1],
    );
    const coauthors = coauthorEmails.map(githubHandleFromNoreply).filter(isEligibleHandle);
    addHandles(coauthors, resolvedCommitCoauthors.get(commit.commit) ?? []);
    const isRevert = Boolean(standardRevertedHash(commit.body));
    const commitReferences = isRevert ? [] : [...commit.references];
    appendReferences(commitReferences, commit.pullRequests);
    appendReferences(references, commitReferences);
    activeCommits.push({
      authorEmail: commit.authorEmail,
      authorHandle: githubHandleFromNoreply(commit.authorEmail),
      authorName: commit.authorName,
      body: commit.body,
      closingReferences: closingReferencesIn(`${commit.subject}\n${commit.body}`),
      coauthors,
      coauthorEmails,
      hash: commit.commit,
      isRevert,
      pullRequests: commit.pullRequests,
      references: commitReferences,
      subject: commit.subject,
    });
    for (const number of commitReferences) {
      const handles = coauthorsByReference.get(number) ?? new Set();
      for (const handle of coauthors) {
        handles.add(handle);
      }
      coauthorsByReference.set(number, handles);
    }
  }
  for (const commit of activeCommits) {
    if (commit.isRevert) {
      continue;
    }
    for (const number of commit.references) {
      revertedReferences.delete(number);
    }
  }
  for (const number of pullRequests) {
    revertedReferences.delete(number);
  }
  return {
    activeCommits,
    coauthorsByReference,
    finalTarget: inventory.range.finalTarget,
    inventory,
    mergeBase: inventory.range.mergeBase,
    pullRequests,
    references,
    revertedReferences,
    sourceTail: inventory.range.sourceTail,
    target: inventory.range.sourceTarget,
    targetTimestamp: inventory.range.targetTimestamp,
  };
}

export function graphqlDataForResponse(response) {
  const errors = Array.isArray(response?.errors) ? response.errors : [];
  if (errors.length > 0) {
    fail(
      `GitHub GraphQL response contained errors:\n${errors
        .map((error) => error?.message || "unknown GraphQL error")
        .join("\n")}`,
    );
  }
  if (response?.data && typeof response.data === "object") {
    return response.data;
  }
  const detail = response?.message ? `\n${response.message}` : "";
  fail(`GitHub GraphQL response did not include data.${detail}`);
}

function graphql(query) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = githubApi(["graphql", "-f", `query=${query}`]);
      return graphqlDataForResponse(response);
    } catch (error) {
      lastError = error;
      const message = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
      // Historical ranges batch hundreds of objects; only retry transient transport failures.
      if (
        !/(?:operation timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|stream error: .*CANCEL|unexpected end of JSON input|upstream connect error|connection termination|connection reset by peer|error connecting to api\.github\.com|Unexpected token '<'|something went wrong|temporarily unavailable|internal server error|rate limit)/i.test(
          message,
        )
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export function resolveAssociatedPullRequests(
  commitHashes,
  targetTimestamp,
  allowExactMergeCommit = true,
  { fetchPage = graphql } = {},
) {
  const states = new Map(
    commitHashes.map((commit) => [
      commit,
      {
        all: [],
        expectedCount: undefined,
        included: [],
        seenCursors: new Set(),
        seenNumbers: new Set(),
      },
    ]),
  );
  const pending = [];
  function appendPage(commit, connection) {
    const state = states.get(commit);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete associatedPullRequests connection for ${commit}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub associatedPullRequests totalCount changed for commit ${commit}`);
    }
    state.expectedCount = connection.totalCount;
    for (const pullRequest of connection.nodes) {
      const hasMergedAt = Object.hasOwn(pullRequest ?? {}, "mergedAt");
      const hasMergeCommit = Object.hasOwn(pullRequest ?? {}, "mergeCommit");
      const mergedAt =
        typeof pullRequest?.mergedAt === "string"
          ? Date.parse(pullRequest.mergedAt)
          : pullRequest?.mergedAt === null
            ? undefined
            : Number.NaN;
      const mergeCommit = pullRequest?.mergeCommit;
      if (
        !Number.isInteger(pullRequest?.number) ||
        pullRequest.number <= 0 ||
        !hasMergedAt ||
        !hasMergeCommit ||
        (pullRequest.mergedAt !== null && !Number.isFinite(mergedAt)) ||
        (mergeCommit !== null &&
          (typeof mergeCommit !== "object" ||
            typeof mergeCommit.oid !== "string" ||
            !/^[0-9a-f]{40}$/.test(mergeCommit.oid)))
      ) {
        fail(`GitHub returned an invalid associated pull request for commit ${commit}`);
      }
      if (state.seenNumbers.has(pullRequest.number)) {
        fail(`GitHub associatedPullRequests returned a duplicate member for commit ${commit}`);
      }
      state.seenNumbers.add(pullRequest.number);
      state.all.push(pullRequest.number);
      const exactMerge = allowExactMergeCommit && pullRequest.mergeCommit?.oid === commit;
      if (exactMerge && mergedAt > targetTimestamp + 1_000) {
        fail(`exact merge association for commit ${commit} was merged after the release target`);
      }
      if (
        Number.isFinite(mergedAt) &&
        (mergedAt <= targetTimestamp || (exactMerge && mergedAt <= targetTimestamp + 1_000))
      ) {
        state.included.push(pullRequest.number);
      }
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub associatedPullRequests repeated cursor ${cursor} for commit ${commit}`);
      }
      state.seenCursors.add(cursor);
      pending.push({ commit, cursor });
    }
  }
  function queryFor(items) {
    return `query { ${items
      .map(
        (item, index) =>
          `c${index}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commit)}) {
              ... on Commit {
                associatedPullRequests(first: 100${
                  item.cursor ? `, after: ${JSON.stringify(item.cursor)}` : ""
                }) {
                  totalCount
                  nodes { number mergedAt mergeCommit { oid } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n")} }`;
  }
  for (let index = 0; index < commitHashes.length; index += commitAssociationQueryBatchSize) {
    const items = commitHashes
      .slice(index, index + commitAssociationQueryBatchSize)
      .map((commit) => ({ commit }));
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.associatedPullRequests);
    }
  }
  while (pending.length > 0) {
    const items = pending.splice(0, 20);
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.associatedPullRequests);
    }
  }
  for (const [commit, state] of states) {
    if (state.seenNumbers.size !== state.expectedCount) {
      fail(
        `GitHub associatedPullRequests did not return ${state.expectedCount} complete unique members for commit ${commit}`,
      );
    }
  }
  return {
    allPullRequests: new Map(
      [...states].map(([commit, state]) => [
        commit,
        state.all.toSorted((left, right) => left - right),
      ]),
    ),
    pullRequests: new Map(
      [...states].map(([commit, state]) => [
        commit,
        state.included.toSorted((left, right) => left - right),
      ]),
    ),
    unresolved: [],
  };
}

function issueConnectionName(node) {
  if (node?.__typename === "Issue") {
    return "closedByPullRequestsReferences";
  }
  if (node?.__typename === "PullRequest") {
    return "closingIssuesReferences";
  }
  return undefined;
}

export function resolveIssueRelationshipPages(nodes, { fetchPage = graphql } = {}) {
  const states = new Map();
  const pending = [];

  function appendPage(number, connection) {
    const state = states.get(number);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete ${state.connectionName} connection for #${number}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub ${state.connectionName} totalCount changed for #${number}`);
    }
    state.expectedCount = connection.totalCount;
    for (const member of connection.nodes) {
      if (!Number.isInteger(member?.number) || member.number <= 0) {
        fail(`GitHub returned an invalid ${state.connectionName} member for #${number}`);
      }
      if (state.seenNumbers.has(member.number)) {
        fail(`GitHub ${state.connectionName} returned a duplicate member for #${number}`);
      }
      state.seenNumbers.add(member.number);
      state.members.push(member);
    }
    if (state.seenNumbers.size > state.expectedCount) {
      fail(`GitHub ${state.connectionName} returned more members than totalCount for #${number}`);
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub ${state.connectionName} repeated cursor ${cursor} for #${number}`);
      }
      state.seenCursors.add(cursor);
      pending.push({
        connectionName: state.connectionName,
        cursor,
        number,
        type: state.type,
      });
    }
  }

  for (const [number, node] of nodes) {
    const connectionName = issueConnectionName(node);
    if (!connectionName || node.number !== number) {
      fail(`GitHub returned an invalid issue or pull request for #${number}`);
    }
    states.set(number, {
      connectionName,
      expectedCount: undefined,
      members: [],
      seenCursors: new Set(),
      seenNumbers: new Set(),
      type: node.__typename,
    });
    appendPage(number, node[connectionName]);
  }

  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map((item, offset) => {
        const connection = `${item.connectionName}(first: 100, after: ${JSON.stringify(item.cursor)}) {
          totalCount
          nodes { number }
          pageInfo { hasNextPage endCursor }
        }`;
        return `n${offset}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${item.number}) {
            ... on ${item.type} {
              number
              ${connection}
            }
          }
        }`;
      })
      .join("\n");
    const data = fetchPage(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const item = chunk[offset];
      const alias = data?.[`n${offset}`];
      const pageNode = alias?.issueOrPullRequest;
      if (
        !alias ||
        !Object.hasOwn(alias, "issueOrPullRequest") ||
        !pageNode ||
        pageNode.number !== item.number
      ) {
        fail(`GitHub did not return issue or pull request #${item.number} while paginating`);
      }
      appendPage(item.number, pageNode[item.connectionName]);
    }
  }

  for (const [number, state] of states) {
    if (state.seenNumbers.size !== state.expectedCount) {
      fail(
        `GitHub ${state.connectionName} did not return ${state.expectedCount} complete unique members for #${number}`,
      );
    }
    nodes.get(number)[state.connectionName] = {
      nodes: state.members,
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: state.expectedCount,
    };
  }
  return nodes;
}

function resolveReferences(numbers) {
  const nodes = new Map();
  for (let index = 0; index < numbers.length; index += 40) {
    const chunk = numbers.slice(index, index + 40);
    const fields = chunk
      .map(
        (number) => `n${number}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${number}) {
            __typename
            ... on Issue {
              number
              title
              author { __typename login }
              closedByPullRequestsReferences(first: 100) {
                totalCount
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
            ... on PullRequest {
              number
              title
              mergedAt
              author { __typename login }
              closingIssuesReferences(first: 100) {
                totalCount
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (const number of chunk) {
      const alias = data?.[`n${number}`];
      if (!alias || !Object.hasOwn(alias, "issueOrPullRequest")) {
        fail(`GitHub did not return an issueOrPullRequest result for #${number}`);
      }
      const node = alias.issueOrPullRequest;
      if (node) {
        nodes.set(number, node);
      }
    }
  }
  return resolveIssueRelationshipPages(nodes);
}

function unresolvedRelationshipMembers(nodes, sourceNumbers, connectionName) {
  const unresolved = [];
  for (const sourceNumber of sourceNumbers) {
    const node = nodes.get(sourceNumber);
    for (const member of node?.[connectionName]?.nodes ?? []) {
      if (!nodes.has(member.number)) {
        unresolved.push({
          connectionName,
          member: member.number,
          source: sourceNumber,
        });
      }
    }
  }
  return unresolved;
}

function resolveGitHubHandles(handles) {
  const resolved = new Map();
  const uniqueHandles = [...new Set(handles)];
  for (let index = 0; index < uniqueHandles.length; index += 80) {
    const chunk = uniqueHandles.slice(index, index + 80);
    const fields = chunk
      .map(
        (handle, offset) =>
          `u${index + offset}: user(login: ${JSON.stringify(handle)}) { __typename login }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const user = data[`u${index + offset}`];
      if (user?.__typename === "User" && isEligibleHandle(user.login)) {
        resolved.set(chunk[offset].toLowerCase(), user.login);
      }
    }
  }
  return resolved;
}

function resolveDirectCommitAuthors(commits) {
  const resolved = new Map();
  const commitsWithoutGitHubHandle = commits.filter((commit) => !commit.author?.handle);
  for (let index = 0; index < commitsWithoutGitHubHandle.length; index += 40) {
    const chunk = commitsWithoutGitHubHandle.slice(index, index + 40);
    const fields = chunk
      .map(
        (commit, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(commit.hash)}) {
              ... on Commit {
                author {
                  user {
                    login
                  }
                }
              }
            }
          }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const author = data[`c${index + offset}`]?.object?.author?.user;
      if (author?.login && isEligibleHandle(author.login)) {
        resolved.set(chunk[offset].hash, author.login);
      }
    }
  }
  return resolved;
}

export function resolveCommitCoauthors(commits, { fetchPage = graphql } = {}) {
  const commitsWithCoauthors = commits.filter((commit) => commit.coauthorEmails.length > 0);
  const states = new Map(
    commitsWithCoauthors.map((commit) => [
      commit.hash,
      {
        coauthorEmails: new Set(commit.coauthorEmails.map((email) => email.toLowerCase())),
        expectedCount: undefined,
        handles: [],
        seenCursors: new Set(),
        seenMembers: new Set(),
      },
    ]),
  );
  const pending = [];

  function appendPage(commit, connection) {
    const state = states.get(commit);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete authors connection for commit ${commit}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub authors totalCount changed for commit ${commit}`);
    }
    state.expectedCount = connection.totalCount;
    for (const author of connection.nodes) {
      if (
        typeof author?.email !== "string" ||
        (author.user !== null &&
          (typeof author.user !== "object" || typeof author.user.login !== "string"))
      ) {
        fail(`GitHub returned an invalid author for commit ${commit}`);
      }
      const memberKey = JSON.stringify({
        email: author.email.toLowerCase(),
        login: author.user?.login?.toLowerCase() ?? null,
      });
      if (state.seenMembers.has(memberKey)) {
        fail(`GitHub authors returned a duplicate member for commit ${commit}`);
      }
      state.seenMembers.add(memberKey);
      if (
        state.coauthorEmails.has(author.email.toLowerCase()) &&
        isEligibleHandle(author.user?.login)
      ) {
        addHandles(state.handles, [author.user.login]);
      }
    }
    if (state.seenMembers.size > state.expectedCount) {
      fail(`GitHub authors returned more members than totalCount for commit ${commit}`);
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub authors repeated cursor ${cursor} for commit ${commit}`);
      }
      state.seenCursors.add(cursor);
      pending.push({ commit, cursor });
    }
  }

  function queryFor(items) {
    return `query { ${items
      .map(
        (item, offset) =>
          `c${offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commit)}) {
              ... on Commit {
                authors(first: 100${item.cursor ? `, after: ${JSON.stringify(item.cursor)}` : ""}) {
                  totalCount
                  nodes {
                    email
                    user { login }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n")} }`;
  }

  for (let index = 0; index < commitsWithCoauthors.length; index += 40) {
    const items = commitsWithCoauthors.slice(index, index + 40).map((commit) => ({
      commit: commit.hash,
    }));
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.authors);
    }
  }
  while (pending.length > 0) {
    const items = pending.splice(0, 20);
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.authors);
    }
  }
  for (const [commit, state] of states) {
    if (state.seenMembers.size !== state.expectedCount) {
      fail(
        `GitHub authors did not return ${state.expectedCount} complete unique members for commit ${commit}`,
      );
    }
  }
  return new Map([...states].map(([commit, state]) => [commit, state.handles]));
}

function withDirectCommitAuthors(commits, resolvedAuthors) {
  return commits.map((commit) => {
    const authorHandle = resolvedAuthors.get(commit.hash) ?? commit.author?.handle;
    const contributors = [];
    if (authorHandle) {
      contributors.push(authorHandle);
    }
    addHandles(contributors, commit.contributors);
    return {
      ...commit,
      author: {
        handle: authorHandle,
        name: commit.author?.name ?? commit.authorName,
      },
      contributors,
    };
  });
}

function thanksFor(node, coauthorHandles) {
  const handles = [];
  if (node.author?.__typename === "User" && isEligibleHandle(node.author.login)) {
    handles.push(node.author.login);
  }
  for (const handle of coauthorHandles) {
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function addHandles(handles, additions) {
  for (const handle of additions) {
    if (!isEligibleHandle(handle)) {
      continue;
    }
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function titleReferences(entries) {
  return [...new Set(entries.flatMap((entry) => referencesIn(entry.title)))];
}

function releaseTitle(title) {
  return title;
}

function withSentenceEnding(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function formatThanks(handles) {
  const mentions = handles.map((handle) => `@${handle}`);
  if (mentions.length <= 1) {
    return mentions[0] ?? "";
  }
  if (mentions.length === 2) {
    return mentions.join(" and ");
  }
  return `${mentions.slice(0, -1).join(", ")}, and ${mentions.at(-1)}`;
}

function directCommitTitleTokens(subject) {
  const title = subject.replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
  return [...new Set(title.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].filter(
    (token) => !genericDirectCommitTerms.has(token),
  );
}

function lineHasTerm(line, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(line);
}

function directCommitMatchesLine(commit, line) {
  if (!line.startsWith("- ")) {
    return false;
  }
  if (commit.closingReferences.some((number) => referencesIn(line).includes(number))) {
    return true;
  }
  const matchingTerms = directCommitTitleTokens(commit.subject).filter((token) =>
    lineHasTerm(line, token),
  );
  return matchingTerms.length >= 2;
}

function directCommitCreditsForLine(line, directCommits) {
  const contributors = [];
  for (const commit of directCommits) {
    if (
      !editorialClassification(commit.subject).editorialEligible ||
      !directCommitMatchesLine(commit, line)
    ) {
      continue;
    }
    addHandles(contributors, commit.contributors);
  }
  return contributors;
}

function completeEditorialCredits(prose, pullRequests, directCommits) {
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  return prose
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) {
        return line;
      }
      const contributors = [];
      for (const number of referencesIn(line)) {
        addHandles(contributors, pullRequestsByNumber.get(number)?.thanks ?? []);
      }
      addHandles(contributors, directCommitCreditsForLine(line, directCommits));
      if (contributors.length === 0) {
        return line;
      }
      const existingContributors = handlesIn(line);
      addHandles(existingContributors, contributors);
      const thanksStart = line.lastIndexOf(" Thanks ");
      const rawContent = thanksStart >= 0 ? line.slice(0, thanksStart) : line;
      const content =
        referencesIn(rawContent).length === 0
          ? withSentenceEnding(rawContent)
          : rawContent.replace(/[.!?]$/, "");
      return `${content} Thanks ${formatThanks(existingContributors)}.`;
    })
    .join("\n");
}

function issueEntries(numbers, nodes, priorIssues = new Map()) {
  return [...new Set(numbers)]
    .map((number) => {
      const node = nodes.get(number);
      if (node?.__typename !== "Issue") {
        return undefined;
      }
      const thanks = thanksFor(node, []);
      addHandles(thanks, priorIssues.get(number)?.thanks ?? []);
      return {
        number,
        thanks,
        title: node.title.replace(/\s+/g, " ").trim(),
      };
    })
    .filter(Boolean);
}

function legacyIssuesByPullRequest(priorRecord, nodes) {
  const result = new Map();
  for (const number of priorRecord.legacyIssues.keys()) {
    const issue = nodes.get(number);
    if (issue?.__typename !== "Issue") {
      continue;
    }
    const pullRequests =
      issue.closedByPullRequestsReferences?.nodes.map((pullRequest) => pullRequest.number) ?? [];
    for (const pullRequest of new Set(pullRequests)) {
      const issues = result.get(pullRequest) ?? [];
      issues.push(number);
      result.set(pullRequest, issues);
    }
  }
  return result;
}

function contributionRelationships(source, nodes, resolvedContributors) {
  const issuesByPullRequest = new Map();
  const directCommits = [];
  for (const commit of source.activeCommits) {
    const pullRequests = commit.pullRequests;
    const issues = issueEntries(commit.closingReferences, nodes);
    if (pullRequests.length === 0) {
      const authorHandle = commit.authorHandle
        ? resolvedContributors.get(commit.authorHandle.toLowerCase())
        : undefined;
      const contributors = [];
      if (authorHandle) {
        contributors.push(authorHandle);
      }
      addHandles(
        contributors,
        commit.coauthors
          .map((handle) => resolvedContributors.get(handle.toLowerCase()))
          .filter(Boolean),
      );
      directCommits.push({
        ...commit,
        author: { handle: authorHandle, name: commit.authorName },
        contributors,
        issues,
      });
      continue;
    }
    if (issues.length === 0) {
      continue;
    }
    for (const number of pullRequests) {
      const existing = issuesByPullRequest.get(number) ?? [];
      issuesByPullRequest.set(number, [...existing, ...issues]);
    }
  }
  return { directCommits, issuesByPullRequest };
}

function mergeIssues(...groups) {
  const entries = new Map();
  for (const group of groups) {
    for (const issue of group) {
      const existing = entries.get(issue.number);
      if (existing) {
        addHandles(existing.thanks, issue.thanks);
      } else {
        entries.set(issue.number, { ...issue, thanks: [...issue.thanks] });
      }
    }
  }
  return [...entries.values()];
}

export function ledgerFor(
  base,
  target,
  references,
  nodes,
  coauthorsByReference,
  resolvedHandles,
  relationships,
  priorRecord,
  sourcePullRequests,
  revertedReferences,
  shippedBaselines,
  targetTimestamp,
) {
  const entries = references.map((number) => {
    const node = nodes.get(number);
    const rawCoauthors = coauthorsByReference.get(number) ?? new Set();
    const coauthors = [...rawCoauthors]
      .map((handle) => resolvedHandles.get(handle.toLowerCase()))
      .filter(Boolean);
    return {
      number,
      title: releaseTitle(node.title.replace(/\s+/g, " ").trim()),
      type: node.__typename,
      mergedAt: node.mergedAt,
      closingIssuesReferences: node.closingIssuesReferences,
      thanks: thanksFor(node, coauthors),
    };
  });

  const recordedPullRequests = new Set([...sourcePullRequests, ...priorRecord.pullRequests.keys()]);
  const pullRequests = entries.filter(
    (entry) =>
      entry.type === "PullRequest" &&
      entry.mergedAt &&
      (sourcePullRequests.has(entry.number) || mergedByTarget(entry.mergedAt, targetTimestamp)) &&
      recordedPullRequests.has(entry.number) &&
      !revertedReferences.has(entry.number),
  );
  const issues = entries.filter((entry) => entry.type === "Issue");
  const legacyIssues = legacyIssuesByPullRequest(priorRecord, nodes);
  const records = pullRequests.map((entry) => {
    const priorEntry = priorRecord.pullRequests.get(entry.number);
    const priorReferences = priorEntry?.references ?? [];
    const titleIssues = issueEntries(referencesIn(entry.title), nodes);
    const closingIssues = issueEntries(
      entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
      nodes,
    );
    const linkedIssues = mergeIssues(
      titleIssues,
      closingIssues,
      relationships.issuesByPullRequest.get(entry.number) ?? [],
      issueEntries(priorReferences, nodes),
      issueEntries(legacyIssues.get(entry.number) ?? [], nodes, priorRecord.legacyIssues),
    );
    const thanks = [...entry.thanks];
    addHandles(thanks, priorEntry?.thanks ?? []);
    for (const issue of linkedIssues) {
      addHandles(thanks, issue.thanks);
    }
    return {
      ...entry,
      ...editorialClassification(entry.title),
      externalReferences: priorEntry?.externalReferences ?? [],
      linkedIssues,
      priorReferences,
      thanks,
    };
  });
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  const ledger = [
    "### Complete contribution record",
    "",
    `This audited record covers the complete ${base}..${target} history: ${records.length} merged PRs. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
    ...(shippedBaselineLine ? ["", shippedBaselineLine] : []),
    "",
    "#### Pull requests",
    "",
    ...records.map((entry) => renderContributionRecordEntry(entry)),
  ].join("\n");
  return {
    entries,
    issues,
    ledger,
    pullRequests: records,
    titleReferences: titleReferences(records),
  };
}

function replaceLedger(changelog, section, ledger, pullRequests, directCommits) {
  const beforeLedger = completeEditorialCredits(
    section.source.replace(/\n+### Complete contribution (?:ledger|record)[\s\S]*$/m, "").trimEnd(),
    pullRequests,
    directCommits,
  );
  const replacement = `${beforeLedger}\n\n${ledger}\n`;
  return `${changelog.slice(0, section.start)}${replacement}${changelog.slice(section.end)}`;
}

export function countTopLevelSectionBullets(sectionSource, heading) {
  const headingMatch = new RegExp(`^### ${escapeRegExp(heading)}\\r?$`, "mu").exec(sectionSource);
  if (!headingMatch || headingMatch.index === undefined) {
    return 0;
  }
  const headingEnd = sectionSource.indexOf("\n", headingMatch.index);
  const bodyStart = headingEnd < 0 ? sectionSource.length : headingEnd + 1;
  const nextHeading = /^### /gmu;
  nextHeading.lastIndex = bodyStart;
  const end = nextHeading.exec(sectionSource)?.index ?? sectionSource.length;
  return sectionSource
    .slice(bodyStart, end)
    .split("\n")
    .filter((line) => line.startsWith("- ")).length;
}

export function highlightCountError(sectionSource) {
  const count = countTopLevelSectionBullets(sectionSource, "Highlights");
  return count >= 5 && count <= 8
    ? undefined
    : `### Highlights must contain 5-8 top-level bullets; found ${count}`;
}

export function ledgerChecks(section, pullRequests, nodes, directCommits, shippedBaselines = []) {
  const errors = [];
  let sectionReferences = referencesIn(section.source);
  if (/@undefined\b/i.test(section.source)) {
    errors.push("release section contains invalid @undefined contributor credit");
  }
  if (!section.source.includes("### Highlights")) {
    errors.push("missing ### Highlights");
  } else {
    const error = highlightCountError(section.source);
    if (error) {
      errors.push(error);
    }
  }
  if (!section.source.includes("### Changes")) {
    errors.push("missing ### Changes");
  }
  if (!section.source.includes("### Fixes")) {
    errors.push("missing ### Fixes");
  }
  const ledgerStart = section.source.indexOf("### Complete contribution record");
  if (ledgerStart < 0) {
    errors.push("missing ### Complete contribution record");
    return errors;
  }
  const ledger = section.source.slice(ledgerStart);
  const expectedShippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  try {
    const sectionShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(section.source),
    );
    const actualShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(ledger),
    );
    if (sectionShippedBaselineLine !== actualShippedBaselineLine) {
      errors.push(
        "shipped baseline exclusions must appear inside the complete contribution record",
      );
    } else if (actualShippedBaselineLine !== expectedShippedBaselineLine) {
      errors.push(
        `shipped baseline exclusions mismatch: expected ${
          expectedShippedBaselineLine || "none"
        }, found ${actualShippedBaselineLine || "none"}`,
      );
    } else {
      sectionReferences = releaseNoteReferences(section.source, shippedBaselines);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (ledger.includes("#### Linked issues")) {
    errors.push("complete contribution record must not have a linked-issues inventory");
  }
  if (ledger.includes("#### Direct commits")) {
    errors.push("complete contribution record must not list direct commits");
  }
  for (const number of new Set(sectionReferences)) {
    if (!nodes.has(number)) {
      errors.push(`unresolved release-note reference #${number}`);
    }
  }
  for (const entry of pullRequests) {
    const line = ledger
      .split("\n")
      .find((candidate) => candidate.startsWith(`- **PR #${entry.number}**`));
    if (!line) {
      errors.push(`missing contribution record for PR #${entry.number}`);
      continue;
    }
    for (const handle of entry.thanks) {
      if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        errors.push(`missing Thanks @${handle} for #${entry.number}`);
      }
    }
    const expectedReferences = [];
    appendUnique(expectedReferences, referenceLabelsIn(entry.title));
    appendUnique(
      expectedReferences,
      entry.priorReferences.map((number) => `#${number}`),
    );
    appendUnique(expectedReferences, entry.externalReferences);
    appendUnique(
      expectedReferences,
      entry.linkedIssues.map((issue) => `#${issue.number}`),
    );
    const actualReferences = new Set(
      referenceLabelsIn(line).map((reference) => reference.toLowerCase()),
    );
    for (const reference of expectedReferences) {
      if (!actualReferences.has(reference.toLowerCase())) {
        errors.push(`missing ${reference} on contribution record for PR #${entry.number}`);
      }
    }
  }
  const editorialProse = section.source.slice(0, ledgerStart);
  for (const entry of pullRequests) {
    if (
      !entry.editorialEligible &&
      new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(editorialProse)
    ) {
      errors.push(
        `editorial release prose references non-editorial ${entry.type} PR #${entry.number} (${entry.type})`,
      );
    }
  }
  const editorialLines = editorialProse.split("\n");
  for (const entry of pullRequests) {
    for (const line of editorialLines) {
      if (
        !new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(line) ||
        !line.startsWith("- ")
      ) {
        continue;
      }
      for (const handle of entry.thanks) {
        if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
          errors.push(`missing editorial Thanks @${handle} for PR #${entry.number}`);
        }
      }
    }
  }
  for (const line of editorialLines) {
    if (!line.startsWith("- ")) {
      continue;
    }
    for (const handle of directCommitCreditsForLine(line, directCommits)) {
      if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        errors.push(`missing editorial Thanks @${handle} for directly landed work`);
      }
    }
  }
  const lines = section.source.split("\n");
  for (const number of new Set(referencesIn(section.source))) {
    const node = nodes.get(number);
    if (node?.__typename !== "Issue") {
      continue;
    }
    for (const handle of thanksFor(node, [])) {
      const credited = lines.some(
        (line) =>
          line.includes(`#${number}`) && line.toLowerCase().includes(`@${handle.toLowerCase()}`),
      );
      if (!credited) {
        errors.push(`missing Thanks @${handle} for issue #${number}`);
      }
    }
  }
  return errors;
}

function summarizedNumbers(numbers) {
  const members = [...new Set(numbers)].toSorted((left, right) => left - right);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(`${JSON.stringify(members)}\n`)
      .digest("hex"),
  };
}

export function ledgerReconciliationFor(
  source,
  renderedRecord,
  generatedPullRequests = [],
  allowedHistoricalPullRequests = [],
) {
  const canonical = new Set(source.inventory.partitions.pullRequests.included.members);
  const current = new Set(renderedRecord.pullRequests.keys());
  const generated = new Set(generatedPullRequests);
  const allowedHistorical = new Set(allowedHistoricalPullRequests);
  const missing = [...canonical].filter((number) => !current.has(number));
  const stale = [...current].filter((number) => !canonical.has(number));
  const generatedMissing = [...canonical].filter((number) => !generated.has(number));
  const generatedUnexpected = [...generated].filter(
    (number) => !canonical.has(number) && !allowedHistorical.has(number),
  );
  return {
    canonicalRows: summarizedNumbers(canonical),
    coverage:
      canonical.size === 0
        ? 1
        : [...canonical].filter((number) => current.has(number)).length / canonical.size,
    currentRows: summarizedNumbers(current),
    equation: `${current.size} - ${stale.length} + ${missing.length} = ${canonical.size}`,
    generatedCoverage:
      canonical.size === 0
        ? 1
        : [...canonical].filter((number) => generated.has(number)).length / canonical.size,
    generatedMissingRows: summarizedNumbers(generatedMissing),
    generatedRows: summarizedNumbers(generated),
    generatedUnexpectedRows: summarizedNumbers(generatedUnexpected),
    missingRows: summarizedNumbers(missing),
    staleRows: summarizedNumbers(stale),
  };
}

function manifestFor(options, source, ledger, directCommitRecords, reconciliation) {
  const directCommits = directCommitRecords.map((commit) => ({
    ...editorialClassification(commit.subject),
    commit: commit.hash.slice(0, 12),
    subject: commit.subject,
    references: commit.references,
    author: commit.author,
    contributors: commit.contributors,
    issues: commit.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      reporter: issue.thanks,
    })),
  }));
  const unlinkedCommits = directCommits.filter((commit) => commit.references.length === 0);
  return {
    schemaVersion: 3,
    base: options.base,
    finalTarget: source.finalTarget,
    inventory: source.inventory,
    reconciliation,
    target: options.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: ledger.entries.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: directCommits.length,
      unlinkedCommits: unlinkedCommits.length,
    },
    pullRequests: ledger.pullRequests.map((entry) => ({
      number: entry.number,
      title: entry.title,
      type: entry.type,
      editorialEligible: entry.editorialEligible,
      thanks: entry.thanks,
      externalReferences: entry.externalReferences,
      relatedReferences: [...new Set([...entry.priorReferences, ...referencesIn(entry.title)])],
      linkedIssues: entry.linkedIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        reporter: issue.thanks,
      })),
    })),
    directCommits,
    unlinkedCommits,
  };
}

function releaseChecks(changelog, version, releaseTags) {
  const checks = [];
  for (const tag of releaseTags) {
    const release = githubApi([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    const verification = verifyGithubReleaseNotes({
      body: release.body ?? "",
      changelog,
      version,
      tag,
      repository: repo,
    });
    checks.push({
      tag,
      releaseId: release.id,
      matches: verification.matches,
      mode: verification.mode,
      bodyLength: verification.actualSize.characters,
      bodyBytes: verification.actualSize.bytes,
    });
  }
  return checks;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  let changelog = readFileSync("CHANGELOG.md", "utf8");
  let section = sectionFor(changelog, options.version);
  const source = sourceCommits(options);
  const shippedBaselineRecords = options.shippedRefs.map(shippedBaselineFor);
  const shippedExclusions = exactShippedPullRequestExclusions(source, shippedBaselineRecords);
  source.shippedBaselines = shippedExclusions.baselines;
  const preexistingNotes = section.source.replace(
    /\n+### Complete contribution (?:ledger|record)[\s\S]*$/m,
    "",
  );
  const noteReferences = referencesIn(preexistingNotes);
  const revertedNoteReferences = noteReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedNoteReferences.length > 0) {
    fail(
      `release notes reference reverted work: ${[...new Set(revertedNoteReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const renderedRecord = contributionRecordFor(section);
  const renderedRecordReferences = contributionRecordMetadataReferences(renderedRecord);
  const revertedRenderedReferences = renderedRecordReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (!options.writeLedger && revertedRenderedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRenderedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const excludedRecordedReferences = new Set([
    ...source.revertedReferences,
    ...shippedExclusions.pullRequests,
  ]);
  const effectiveRenderedRecord = options.writeLedger
    ? withoutExcludedContributionRecords(renderedRecord, excludedRecordedReferences)
    : renderedRecord;
  const effectiveRenderedRecordReferences =
    contributionRecordMetadataReferences(effectiveRenderedRecord);
  let priorRecord = { legacyIssues: new Map(), pullRequests: new Map() };
  if (options.seedRef) {
    const seedChangelog = git(["show", `${options.seedRef}:CHANGELOG.md`]);
    const seedSection = sectionFor(seedChangelog, options.version);
    priorRecord = contributionRecordFor(seedSection);
  }
  priorRecord = withoutExcludedContributionRecords(priorRecord, excludedRecordedReferences);
  const recordedReferences = contributionRecordMetadataReferences(priorRecord);
  const revertedRecordedReferences = recordedReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedRecordedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRecordedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const references = [...source.references];
  appendReferences(references, noteReferences);
  appendReferences(references, effectiveRenderedRecordReferences);
  appendReferences(references, recordedReferences);
  let nodes = resolveReferences(references);
  const contamination = contaminatingPullRequestReferences({
    noteReferences,
    recordedReferences: effectiveRenderedRecordReferences,
    sourcePullRequests: source.pullRequests,
    seededPullRequests: new Set(priorRecord.pullRequests.keys()),
    nodes,
  });
  if (contamination.length > 0) {
    fail(
      `release section contains PRs outside ${options.base}..${options.target}: ${contamination
        .map((number) => `#${number}`)
        .join(", ")}; use --seed-ref only for an intentional historical backfill`,
    );
  }
  const legacyIssuePullRequests = [...legacyIssuesByPullRequest(priorRecord, nodes).keys()].filter(
    (number) => !shippedExclusions.pullRequests.has(number),
  );
  appendReferences(references, legacyIssuePullRequests);
  nodes = resolveReferences(references);
  const unresolvedSourceReferences = references.filter((number) => !nodes.has(number));
  if (unresolvedSourceReferences.length > 0) {
    fail(
      `GitHub could not resolve source references: ${unresolvedSourceReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const provisionalEntries = references
    .map((number) => nodes.get(number))
    .filter((node) => node?.__typename === "PullRequest");
  const titleReferenceNumbers = titleReferences(provisionalEntries);
  const closingIssueNumbers = provisionalEntries.flatMap(
    (entry) => entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
  );
  const resolvedReferences = [...references];
  appendReferences(resolvedReferences, titleReferenceNumbers);
  appendReferences(resolvedReferences, closingIssueNumbers);
  nodes = resolveReferences(resolvedReferences);
  const relationshipDrift = [
    ...unresolvedRelationshipMembers(
      nodes,
      references.filter((number) => nodes.get(number)?.__typename === "PullRequest"),
      "closingIssuesReferences",
    ),
    ...unresolvedRelationshipMembers(
      nodes,
      priorRecord.legacyIssues.keys(),
      "closedByPullRequestsReferences",
    ),
  ];
  if (relationshipDrift.length > 0) {
    fail(
      `GitHub relationships changed while resolving release references: ${relationshipDrift
        .map(
          (entry) =>
            `#${entry.source} ${entry.connectionName} now includes unresolved #${entry.member}`,
        )
        .join(", ")}; rerun the verifier`,
    );
  }
  const invalidRecordedPullRequests = [...priorRecord.pullRequests.keys()].filter((number) => {
    const node = nodes.get(number);
    return (
      node?.__typename !== "PullRequest" ||
      !node.mergedAt ||
      (!source.pullRequests.has(number) && !mergedByTarget(node.mergedAt, source.targetTimestamp))
    );
  });
  if (!options.writeLedger && invalidRecordedPullRequests.length > 0) {
    fail(
      `contribution record contains unresolved or unmerged PRs: ${invalidRecordedPullRequests
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const unresolvedTitleReferences = titleReferenceNumbers.filter((number) => !nodes.has(number));
  if (unresolvedTitleReferences.length > 0) {
    fail(
      `GitHub could not resolve PR-title references: ${unresolvedTitleReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const contributorHandles = [
    ...source.activeCommits.flatMap((commit) => commit.coauthors),
    ...source.activeCommits.map((commit) => commit.authorHandle).filter(Boolean),
  ];
  const resolvedHandles = resolveGitHubHandles(contributorHandles);
  const relationships = contributionRelationships(source, nodes, resolvedHandles);
  const resolvedCommitAuthors = resolveDirectCommitAuthors(relationships.directCommits);
  relationships.directCommits = withDirectCommitAuthors(
    relationships.directCommits,
    resolvedCommitAuthors,
  );
  const ledger = ledgerFor(
    options.base,
    source.target,
    references,
    nodes,
    source.coauthorsByReference,
    resolvedHandles,
    relationships,
    priorRecord,
    source.pullRequests,
    source.revertedReferences,
    source.shippedBaselines,
    source.targetTimestamp,
  );
  const reconciliation = ledgerReconciliationFor(
    source,
    renderedRecord,
    ledger.pullRequests.map((entry) => entry.number),
    priorRecord.pullRequests.keys(),
  );
  const manifest = manifestFor(
    { ...options, target: source.target },
    source,
    ledger,
    relationships.directCommits,
    reconciliation,
  );
  let candidateChangelog = changelog;
  let candidateSection = section;
  if (options.writeLedger) {
    candidateChangelog = replaceLedger(
      changelog,
      section,
      ledger.ledger,
      ledger.pullRequests,
      relationships.directCommits,
    );
    candidateSection = sectionFor(candidateChangelog, options.version);
  }

  const errors = ledgerChecks(
    candidateSection,
    ledger.pullRequests,
    nodes,
    relationships.directCommits,
    source.shippedBaselines,
  );
  if (reconciliation.generatedMissingRows.count > 0) {
    errors.push(
      `generated contribution record is missing canonical PRs: ${reconciliation.generatedMissingRows.members
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  if (reconciliation.generatedUnexpectedRows.count > 0) {
    errors.push(
      `generated contribution record contains non-canonical PRs outside --seed-ref: ${reconciliation.generatedUnexpectedRows.members
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const github = options.checkGithub
    ? releaseChecks(candidateChangelog, options.version, options.releaseTags)
    : [];
  for (const check of github) {
    if (!check.matches) {
      errors.push(
        `GitHub release ${check.tag} does not match the ${options.version} CHANGELOG section`,
      );
    }
  }
  if (!options.writeLedger || errors.length === 0) {
    if (options.manifestPath) {
      writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (options.writeLedger) {
      writeFileSync("CHANGELOG.md", candidateChangelog);
      changelog = candidateChangelog;
      section = candidateSection;
    }
  }

  const result = {
    base: options.base,
    finalTarget: source.finalTarget,
    inventorySha256: source.inventory.sha256,
    target: source.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: references.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: manifest.directCommits.length,
      unlinkedCommits: manifest.unlinkedCommits.length,
    },
    github,
    reconciliation,
    errors,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${options.version}: ${ledger.pullRequests.length} PRs, ${ledger.issues.length} issues, ${errors.length === 0 ? "verified" : `${errors.length} errors`}\n`,
    );
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
