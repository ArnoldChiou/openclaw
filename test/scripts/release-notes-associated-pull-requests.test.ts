import { describe, expect, it } from "vitest";
import {
  graphqlDataForResponse,
  resolveAssociatedPullRequests,
  resolveCommitCoauthors,
  resolveIssueRelationshipPages,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const commit = "a".repeat(40);
const targetTimestamp = Date.parse("2026-07-10T08:33:14Z");

function page({
  count,
  cursor = null,
  hasNextPage,
  nodes,
}: {
  count?: number;
  cursor?: string | null;
  hasNextPage: boolean;
  nodes: unknown[];
}) {
  return {
    c0: {
      object: {
        associatedPullRequests: {
          ...(count === undefined ? {} : { totalCount: count }),
          nodes,
          pageInfo: { endCursor: cursor, hasNextPage },
        },
      },
    },
  };
}

describe("release-note GraphQL evidence", () => {
  it("rejects partial data when GraphQL also returned errors", () => {
    expect(() =>
      graphqlDataForResponse({
        data: { c0: { object: null } },
        errors: [{ message: "commit alias failed" }],
      }),
    ).toThrow("commit alias failed");
  });

  it("requires data when no GraphQL errors were returned", () => {
    expect(() => graphqlDataForResponse({})).toThrow("did not include data");
  });
});

describe("commit association pagination", () => {
  it("reconciles every page against one stable count", () => {
    const responses = [
      page({
        count: 2,
        cursor: "next",
        hasNextPage: true,
        nodes: [
          {
            mergeCommit: { oid: commit },
            mergedAt: "2026-07-10T08:33:14Z",
            number: 103073,
          },
        ],
      }),
      page({
        count: 2,
        hasNextPage: false,
        nodes: [{ mergeCommit: null, mergedAt: null, number: 103429 }],
      }),
    ];

    const result = resolveAssociatedPullRequests([commit], targetTimestamp, true, {
      fetchPage: () => responses.shift(),
    });

    expect(result.pullRequests.get(commit)).toEqual([103073]);
    expect(result.allPullRequests.get(commit)).toEqual([103073, 103429]);
    expect(responses).toHaveLength(0);
  });

  it.each([
    {
      label: "missing alias",
      responses: [{}],
      error: "complete associatedPullRequests connection",
    },
    {
      label: "missing totalCount",
      responses: [page({ hasNextPage: false, nodes: [] })],
      error: "complete associatedPullRequests connection",
    },
    {
      label: "truncated final page",
      responses: [
        page({
          count: 2,
          hasNextPage: false,
          nodes: [{ mergeCommit: null, mergedAt: null, number: 1 }],
        }),
      ],
      error: "complete unique members",
    },
    {
      label: "duplicate member",
      responses: [
        page({
          count: 2,
          hasNextPage: false,
          nodes: [
            { mergeCommit: null, mergedAt: null, number: 1 },
            { mergeCommit: null, mergedAt: null, number: 1 },
          ],
        }),
      ],
      error: "duplicate member",
    },
    {
      label: "repeated cursor",
      responses: [
        page({
          count: 2,
          cursor: "next",
          hasNextPage: true,
          nodes: [{ mergeCommit: null, mergedAt: null, number: 1 }],
        }),
        page({
          count: 2,
          cursor: "next",
          hasNextPage: true,
          nodes: [{ mergeCommit: null, mergedAt: null, number: 2 }],
        }),
      ],
      error: "repeated cursor",
    },
    {
      label: "count drift",
      responses: [
        page({
          count: 2,
          cursor: "next",
          hasNextPage: true,
          nodes: [{ mergeCommit: null, mergedAt: null, number: 1 }],
        }),
        page({
          count: 3,
          hasNextPage: false,
          nodes: [{ mergeCommit: null, mergedAt: null, number: 2 }],
        }),
      ],
      error: "totalCount changed",
    },
  ])("rejects $label", ({ responses, error }) => {
    expect(() =>
      resolveAssociatedPullRequests([commit], targetTimestamp, true, {
        fetchPage: () => responses.shift(),
      }),
    ).toThrow(error);
  });

  it("allows only the documented one-second exact-merge timestamp skew", () => {
    const withinSkew = page({
      count: 1,
      hasNextPage: false,
      nodes: [
        {
          mergeCommit: { oid: commit },
          mergedAt: "2026-07-10T08:33:15Z",
          number: 1,
        },
      ],
    });
    expect(
      resolveAssociatedPullRequests([commit], targetTimestamp, true, {
        fetchPage: () => withinSkew,
      }).pullRequests.get(commit),
    ).toEqual([1]);

    const afterSkew = page({
      count: 1,
      hasNextPage: false,
      nodes: [
        {
          mergeCommit: { oid: commit },
          mergedAt: "2026-07-10T08:33:16Z",
          number: 1,
        },
      ],
    });
    expect(() =>
      resolveAssociatedPullRequests([commit], targetTimestamp, true, {
        fetchPage: () => afterSkew,
      }),
    ).toThrow("merged after the release target");
  });
});

function relationshipConnection({
  count,
  cursor = null,
  hasNextPage,
  nodes,
}: {
  count?: number;
  cursor?: string | null;
  hasNextPage: boolean;
  nodes: unknown[];
}) {
  return {
    ...(count === undefined ? {} : { totalCount: count }),
    nodes,
    pageInfo: { endCursor: cursor, hasNextPage },
  };
}

function relationshipNode(type: "Issue" | "PullRequest", connection: unknown, number = 103063) {
  const connectionName =
    type === "Issue" ? "closedByPullRequestsReferences" : "closingIssuesReferences";
  return {
    __typename: type,
    [connectionName]: connection,
    number,
  };
}

describe("issue and pull request relationship pagination", () => {
  it.each([
    {
      connectionName: "closedByPullRequestsReferences",
      type: "Issue" as const,
    },
    {
      connectionName: "closingIssuesReferences",
      type: "PullRequest" as const,
    },
  ])(
    "reconciles every $connectionName page against one stable count",
    ({ connectionName, type }) => {
      const nodes = new Map([
        [
          103063,
          relationshipNode(
            type,
            relationshipConnection({
              count: 2,
              cursor: "next",
              hasNextPage: true,
              nodes: [{ number: 103073 }],
            }),
          ),
        ],
      ]);
      const responses = [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              [connectionName]: relationshipConnection({
                count: 2,
                hasNextPage: false,
                nodes: [{ number: 103095 }],
              }),
            },
          },
        },
      ];
      const queries: string[] = [];

      resolveIssueRelationshipPages(nodes, {
        fetchPage: (query) => {
          queries.push(query);
          return responses.shift();
        },
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain(`${connectionName}(first: 100, after: "next")`);
      expect(queries[0]).toContain("totalCount");
      expect(nodes.get(103063)).toMatchObject({
        [connectionName]: {
          totalCount: 2,
          nodes: [{ number: 103073 }, { number: 103095 }],
          pageInfo: { hasNextPage: false },
        },
      });
      expect(responses).toHaveLength(0);
    },
  );

  it.each([
    {
      label: "wrong initial identity",
      initial: relationshipConnection({ count: 0, hasNextPage: false, nodes: [] }),
      responses: [],
      nodeNumber: 103064,
      error: "invalid issue or pull request",
    },
    {
      label: "missing initial connection",
      initial: undefined,
      responses: [],
      error: "complete closedByPullRequestsReferences connection",
    },
    {
      label: "missing initial totalCount",
      initial: relationshipConnection({ hasNextPage: false, nodes: [] }),
      responses: [],
      error: "complete closedByPullRequestsReferences connection",
    },
    {
      label: "missing paginated alias",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [{}],
      error: "while paginating",
    },
    {
      label: "missing paginated result",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [{ n0: {} }],
      error: "while paginating",
    },
    {
      label: "null paginated node",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [{ n0: { issueOrPullRequest: null } }],
      error: "while paginating",
    },
    {
      label: "wrong paginated identity",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103064,
              closedByPullRequestsReferences: relationshipConnection({
                count: 1,
                hasNextPage: false,
                nodes: [{ number: 103073 }],
              }),
            },
          },
        },
      ],
      error: "while paginating",
    },
    {
      label: "missing paginated connection",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [{ n0: { issueOrPullRequest: { number: 103063 } } }],
      error: "complete closedByPullRequestsReferences connection",
    },
    {
      label: "missing paginated totalCount",
      initial: relationshipConnection({
        count: 1,
        cursor: "next",
        hasNextPage: true,
        nodes: [],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              closedByPullRequestsReferences: relationshipConnection({
                hasNextPage: false,
                nodes: [{ number: 103073 }],
              }),
            },
          },
        },
      ],
      error: "complete closedByPullRequestsReferences connection",
    },
    {
      label: "truncated final page",
      initial: relationshipConnection({
        count: 2,
        cursor: "next",
        hasNextPage: true,
        nodes: [{ number: 103073 }],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              closedByPullRequestsReferences: relationshipConnection({
                count: 2,
                hasNextPage: false,
                nodes: [],
              }),
            },
          },
        },
      ],
      error: "complete unique members",
    },
    {
      label: "duplicate member",
      initial: relationshipConnection({
        count: 2,
        cursor: "next",
        hasNextPage: true,
        nodes: [{ number: 103073 }],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              closedByPullRequestsReferences: relationshipConnection({
                count: 2,
                hasNextPage: false,
                nodes: [{ number: 103073 }],
              }),
            },
          },
        },
      ],
      error: "duplicate member",
    },
    {
      label: "invalid member",
      initial: relationshipConnection({
        count: 1,
        hasNextPage: false,
        nodes: [{ number: 0 }],
      }),
      responses: [],
      error: "invalid closedByPullRequestsReferences member",
    },
    {
      label: "more members than totalCount",
      initial: relationshipConnection({
        count: 1,
        hasNextPage: false,
        nodes: [{ number: 103073 }, { number: 103095 }],
      }),
      responses: [],
      error: "more members than totalCount",
    },
    {
      label: "repeated cursor",
      initial: relationshipConnection({
        count: 2,
        cursor: "next",
        hasNextPage: true,
        nodes: [{ number: 103073 }],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              closedByPullRequestsReferences: relationshipConnection({
                count: 2,
                cursor: "next",
                hasNextPage: true,
                nodes: [{ number: 103095 }],
              }),
            },
          },
        },
      ],
      error: "repeated cursor",
    },
    {
      label: "count drift",
      initial: relationshipConnection({
        count: 2,
        cursor: "next",
        hasNextPage: true,
        nodes: [{ number: 103073 }],
      }),
      responses: [
        {
          n0: {
            issueOrPullRequest: {
              number: 103063,
              closedByPullRequestsReferences: relationshipConnection({
                count: 3,
                hasNextPage: false,
                nodes: [{ number: 103095 }],
              }),
            },
          },
        },
      ],
      error: "totalCount changed",
    },
  ])("rejects $label", ({ initial, responses, nodeNumber, error }) => {
    const nodes = new Map([[103063, relationshipNode("Issue", initial, nodeNumber ?? 103063)]]);

    expect(() =>
      resolveIssueRelationshipPages(nodes, {
        fetchPage: () => responses.shift(),
      }),
    ).toThrow(error);
  });
});

function authorConnection({
  count,
  cursor = null,
  hasNextPage,
  nodes,
}: {
  count?: number;
  cursor?: string | null;
  hasNextPage: boolean;
  nodes: unknown[];
}) {
  return {
    ...(count === undefined ? {} : { totalCount: count }),
    nodes,
    pageInfo: { endCursor: cursor, hasNextPage },
  };
}

describe("commit coauthor pagination", () => {
  const commits = [{ coauthorEmails: ["contributor@example.com"], hash: commit }];

  it("resolves non-noreply coauthors across every counted page", () => {
    const responses = [
      {
        c0: {
          object: {
            authors: authorConnection({
              count: 2,
              cursor: "next",
              hasNextPage: true,
              nodes: [{ email: "author@example.com", user: null }],
            }),
          },
        },
      },
      {
        c0: {
          object: {
            authors: authorConnection({
              count: 2,
              hasNextPage: false,
              nodes: [{ email: "Contributor@Example.com", user: { login: "alice" } }],
            }),
          },
        },
      },
    ];
    const queries: string[] = [];

    const result = resolveCommitCoauthors(commits, {
      fetchPage: (query) => {
        queries.push(query);
        return responses.shift();
      },
    });

    expect(result.get(commit)).toEqual(["alice"]);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("authors(first: 100)");
    expect(queries[1]).toContain('authors(first: 100, after: "next")');
    expect(queries.every((query) => query.includes("totalCount"))).toBe(true);
  });

  it("fails closed on missing counts, duplicate members, and truncated pages", () => {
    expect(() =>
      resolveCommitCoauthors(commits, {
        fetchPage: () => ({
          c0: {
            object: {
              authors: authorConnection({
                hasNextPage: false,
                nodes: [],
              }),
            },
          },
        }),
      }),
    ).toThrow("complete authors connection");

    expect(() =>
      resolveCommitCoauthors(commits, {
        fetchPage: () => ({
          c0: {
            object: {
              authors: authorConnection({
                count: 2,
                hasNextPage: false,
                nodes: [
                  { email: "contributor@example.com", user: { login: "alice" } },
                  { email: "contributor@example.com", user: { login: "alice" } },
                ],
              }),
            },
          },
        }),
      }),
    ).toThrow("duplicate member");

    expect(() =>
      resolveCommitCoauthors(commits, {
        fetchPage: () => ({
          c0: {
            object: {
              authors: authorConnection({
                count: 2,
                hasNextPage: false,
                nodes: [{ email: "contributor@example.com", user: { login: "alice" } }],
              }),
            },
          },
        }),
      }),
    ).toThrow("complete unique members");
  });
});
