// Tests for openclaw.clawFeed.v1 local feed parsing and resolution.
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClawFeed, readClawManifestFromFeed } from "./feed.js";

const baseManifest = {
  schemaVersion: "openclaw.claw.v1",
  id: "incident-response",
  name: "Incident Response",
  version: "1.0.0",
  entries: [
    {
      kind: "skill",
      id: "triage",
      selector: "clawhub:incident-triage@1.0.0",
    },
  ],
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
  it("parses feed entries and preserves owner metadata", () => {
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

  it("warns when feed entries omit ownership metadata", () => {
    const result = parseClawFeed({
      ...baseFeed,
      entries: [
        {
          id: "incident-response",
          name: "Incident Response",
          version: "1.0.0",
          source: "incident-response.claw.json",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected feed to parse");
    }
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "feed_entry_owner_missing",
        path: "$.entries[0]",
      }),
    ]);
  });

  it("fails duplicate feed entry ids", () => {
    const result = parseClawFeed({
      ...baseFeed,
      entries: [baseFeed.entries[0], { ...baseFeed.entries[0], name: "Duplicate" }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "duplicate_feed_entry", path: "$.entries[1]" }),
    ]);
  });
});

describe("readClawManifestFromFeed", () => {
  it("resolves a local feed entry to a claw manifest", async () => {
    const { feedPath, manifestPath } = await writeFeedWorkspace(baseFeed);

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected feed manifest to parse");
    }
    expect(result.manifestPath).toBe(manifestPath);
    expect(result.manifest.id).toBe("incident-response");
  });

  it("resolves file URL sources that stay under the feed directory", async () => {
    const { feedPath, manifestPath } = await writeFeedWorkspace(baseFeed);
    await writeFile(
      feedPath,
      JSON.stringify({
        ...baseFeed,
        entries: [
          {
            ...baseFeed.entries[0],
            source: pathToFileURL(manifestPath).href,
          },
        ],
      }),
      "utf8",
    );

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected file URL feed manifest to parse");
    }
    expect(result.manifest.id).toBe("incident-response");
  });

  it("blocks file URL sources that escape the feed directory", async () => {
    const { manifestPath } = await writeFeedWorkspace(baseFeed);
    const { feedPath } = await writeFeedWorkspace({
      ...baseFeed,
      entries: [
        {
          ...baseFeed.entries[0],
          source: pathToFileURL(manifestPath).href,
        },
      ],
    });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_source_escapes_root", path: "$.entries[0]" }),
    );
  });

  it("allows in-root manifest names that start with two dots", async () => {
    const { dir, feedPath } = await writeFeedWorkspace(baseFeed);
    const dotManifestPath = join(dir, "..starter.claw.json");
    await writeFile(dotManifestPath, JSON.stringify(baseManifest), "utf8");
    await writeFile(
      feedPath,
      JSON.stringify({
        ...baseFeed,
        entries: [
          {
            ...baseFeed.entries[0],
            source: "..starter.claw.json",
          },
        ],
      }),
      "utf8",
    );

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected dot-prefixed feed manifest to parse");
    }
    expect(result.manifest.id).toBe("incident-response");
  });

  it.runIf(process.platform !== "win32")(
    "blocks symlinked feed sources that escape the feed directory",
    async () => {
      const outside = await writeFeedWorkspace(baseFeed);
      const inside = await writeFeedWorkspace(baseFeed);
      const linkPath = join(inside.dir, "linked.claw.json");
      await symlink(outside.manifestPath, linkPath);
      await writeFile(
        inside.feedPath,
        JSON.stringify({
          ...baseFeed,
          entries: [
            {
              ...baseFeed.entries[0],
              source: "linked.claw.json",
            },
          ],
        }),
        "utf8",
      );

      const result = await readClawManifestFromFeed({
        feedPath: inside.feedPath,
        entryId: "incident-response",
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "feed_source_escapes_root", path: "$.entries[0]" }),
      );
    },
  );

  it("blocks relative feed sources that escape the feed directory", async () => {
    const { feedPath } = await writeFeedWorkspace({
      ...baseFeed,
      entries: [{ ...baseFeed.entries[0], source: "../incident-response.claw.json" }],
    });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_source_escapes_root", path: "$.entries[0]" }),
    );
  });

  it("blocks remote feed sources in the read-only local implementation", async () => {
    const { feedPath } = await writeFeedWorkspace({
      ...baseFeed,
      entries: [
        {
          ...baseFeed.entries[0],
          source: "https://clawhub.ai/claws/incident-response.json",
        },
      ],
    });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unsupported_feed_source", path: "$.entries[0]" }),
    );
  });

  it("fails when a feed entry points at a different manifest id", async () => {
    const { feedPath } = await writeFeedWorkspace(baseFeed, { ...baseManifest, id: "other-claw" });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_manifest_id_mismatch", path: "$.entries[0]" }),
    );
  });

  it("fails when a feed entry points at a different manifest version", async () => {
    const { feedPath } = await writeFeedWorkspace(baseFeed, { ...baseManifest, version: "2.0.0" });

    const result = await readClawManifestFromFeed({ feedPath, entryId: "incident-response" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "feed_manifest_version_mismatch", path: "$.entries[0]" }),
    );
  });
});
