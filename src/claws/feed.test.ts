// Tests for local feed parsing and grouped Claw manifest resolution.
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClawFeed, readClawManifestFromFeed } from "./feed.js";

const baseManifest = {
  schemaVersion: 1,
  agent: { id: "incident-response", name: "Incident Response" },
  packages: [{ kind: "skill", source: "clawhub", ref: "incident-triage", version: "1.0.0" }],
};

const baseFeed = {
  schemaVersion: "openclaw.clawFeed.v1",
  id: "local-starters",
  name: "Local Starters",
  entries: [
    {
      id: "incident-response",
      name: "Incident Response",
      version: "1.0.0",
      source: "incident-response.claw.json",
      owner: { type: "publisher", id: "openclaw.examples" },
      trust: { level: "source" },
    },
  ],
};

async function writeFeedWorkspace(feed: unknown, manifest: unknown = baseManifest) {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-feed-"));
  const feedPath = join(dir, "claws.feed.json");
  const manifestPath = join(dir, "incident-response.claw.json");
  await writeFile(feedPath, JSON.stringify(feed), "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { dir, feedPath, manifestPath };
}

describe("parseClawFeed", () => {
  it("preserves publisher ownership metadata", () => {
    const result = parseClawFeed(baseFeed);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected feed to parse");
    }
    expect(result.feed.entries[0]).toMatchObject({
      id: "incident-response",
      owner: { type: "publisher", id: "openclaw.examples" },
      trust: { level: "source" },
    });
  });

  it("warns when ownership metadata is missing", () => {
    const withoutOwner = { ...baseFeed.entries[0] } as Record<string, unknown>;
    delete withoutOwner.owner;
    const valid = parseClawFeed({ ...baseFeed, entries: [withoutOwner] });
    expect(valid.ok).toBe(true);
    expect(valid.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_entry_owner_missing", path: "$.entries[0]" }),
    );
  });

  it("rejects duplicate feed ids", () => {
    const result = parseClawFeed({
      ...baseFeed,
      entries: [baseFeed.entries[0], { ...baseFeed.entries[0] }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_feed_entry", path: "$.entries[1]" }),
    );
  });
});

describe("readClawManifestFromFeed", () => {
  it("resolves a grouped manifest and takes package identity from the feed", async () => {
    const { feedPath, manifestPath } = await writeFeedWorkspace(baseFeed);
    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected feed manifest to parse");
    }
    expect(result.manifestPath).toBe(manifestPath);
    expect(result.manifest.agent.id).toBe("incident-response");
    expect(result.source).toMatchObject({
      kind: "package",
      name: "incident-response",
      version: "1.0.0",
    });
  });

  it("resolves file URLs that stay under the feed directory", async () => {
    const { feedPath, manifestPath } = await writeFeedWorkspace(baseFeed);
    await writeFile(
      feedPath,
      JSON.stringify({
        ...baseFeed,
        entries: [{ ...baseFeed.entries[0], source: pathToFileURL(manifestPath).href }],
      }),
      "utf8",
    );

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });
    expect(result.ok).toBe(true);
  });

  it("blocks feed sources outside the feed root", async () => {
    const outside = await writeFeedWorkspace(baseFeed);
    const inside = await writeFeedWorkspace({
      ...baseFeed,
      entries: [{ ...baseFeed.entries[0], source: pathToFileURL(outside.manifestPath).href }],
    });

    const result = await readClawManifestFromFeed({
      feedPath: inside.feedPath,
      entryId: "incident-response",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_source_escapes_root", path: "$.entries[0]" }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "blocks symlinked feed sources outside the feed root",
    async () => {
      const outside = await writeFeedWorkspace(baseFeed);
      const inside = await writeFeedWorkspace(baseFeed);
      const linkPath = join(inside.dir, "linked.claw.json");
      await symlink(outside.manifestPath, linkPath);
      await writeFile(
        inside.feedPath,
        JSON.stringify({
          ...baseFeed,
          entries: [{ ...baseFeed.entries[0], source: "linked.claw.json" }],
        }),
        "utf8",
      );

      const result = await readClawManifestFromFeed({
        feedPath: inside.feedPath,
        entryId: "incident-response",
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "feed_source_escapes_root" }),
      );
    },
  );

  it("blocks remote feed sources in the local implementation", async () => {
    const { feedPath } = await writeFeedWorkspace({
      ...baseFeed,
      entries: [{ ...baseFeed.entries[0], source: "https://clawhub.ai/claws/demo.json" }],
    });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unsupported_feed_source", path: "$.entries[0]" }),
    );
  });
});
