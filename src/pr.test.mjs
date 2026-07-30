import { expect, test } from "bun:test";
import { listAllPRs } from "./pr.mjs";

test("listAllPRs includes drafts and combines every paginated result", async () => {
  let args;
  const pages = [
    {
      data: {
        repository: {
          nameWithOwner: "acme/widgets",
          pullRequests: {
            nodes: [
              {
                number: 12,
                title: "Draft work",
                isDraft: true,
                updatedAt: "2026-07-28T00:00:00Z",
                labels: { nodes: [{ name: "wip", color: "cccccc", description: "" }] },
              },
            ],
          },
        },
      },
    },
    {
      data: {
        repository: {
          nameWithOwner: "acme/widgets",
          pullRequests: {
            nodes: [
              {
                number: 14,
                title: "Ready work",
                isDraft: false,
                updatedAt: "2026-07-29T00:00:00Z",
                labels: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  ];
  const runGh = async (received) => {
    args = received;
    return { status: 0, stdout: JSON.stringify(pages), stderr: "" };
  };

  const prs = await listAllPRs(runGh);

  expect(args).toContain("--paginate");
  expect(args).toContain("--slurp");
  expect(args.join(" ")).toContain("states: OPEN");
  expect(prs.map((pr) => pr.number)).toEqual([14, 12]);
  expect(prs[1]).toMatchObject({
    isDraft: true,
    repo: "acme/widgets",
    labels: [{ name: "wip", color: "cccccc", description: "" }],
  });
});

test("listAllPRs rejects malformed GitHub responses", async () => {
  const runGh = async () => ({ status: 0, stdout: "{}", stderr: "" });
  expect(listAllPRs(runGh)).rejects.toThrow("invalid response");
});
