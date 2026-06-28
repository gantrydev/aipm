import { z } from "zod";

// Lenient schemas for the GitHub GraphQL reads (DESIGN §4). `looseObject` keeps
// every node tolerant of fields GitHub adds (and of the extra fields our tests
// pass), while every field we actually consume in normalize + discoverLinks is
// declared and optional. Parsing happens once at the boundary (ghGraphQL); every
// consumer downstream receives these typed nodes, never `unknown`.

const loginSchema = z.object({ login: z.string().optional() });
const reviewerSchema = z.object({ login: z.string().optional(), slug: z.string().optional() });
const labelSchema = z.object({ name: z.string().optional() });
const pageInfoSchema = z.object({
  hasNextPage: z.boolean().optional(),
  endCursor: z.string().optional(),
});

const refSchema = z.object({
  number: z.number().optional(),
  repository: z.object({ nameWithOwner: z.string().optional() }).optional(),
});

const connSchema = <S extends z.ZodType>(node: S) =>
  z.object({ nodes: z.array(node).optional(), pageInfo: pageInfoSchema.optional() });

/** One timeline union node — wide + loose: every field read across the issue and
 *  PR timelines is optional, unknown variants/fields pass through untouched. */
export const graphqlTimelineNodeSchema = z.looseObject({
  __typename: z.string().optional(),
  actor: loginSchema.nullish(),
  author: loginSchema.nullish(),
  createdAt: z.string().optional(),
  submittedAt: z.string().optional(),
  body: z.string().optional(),
  state: z.string().optional(),
  stateReason: z.string().nullish(),
  label: labelSchema.nullish(),
  assignee: loginSchema.nullish(),
  requestedReviewer: reviewerSchema.nullish(),
  commit: z.object({ oid: z.string().optional() }).nullish(),
  previousTitle: z.string().nullish(),
  currentTitle: z.string().nullish(),
  // link-only targets (discoverLinks)
  source: refSchema.nullish(),
  subject: refSchema.nullish(),
  canonical: refSchema.nullish(),
});
export type GraphqlTimelineNode = z.infer<typeof graphqlTimelineNodeSchema>;

/** A fetched issue/PR node with its (paginated) timeline. Loose so a node missing
 *  issue-only or PR-only fields still parses; consumers read declared fields. */
export const graphqlNodeSchema = z.looseObject({
  number: z.number().optional(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  state: z.string().optional(),
  stateReason: z.string().nullish(),
  isDraft: z.boolean().optional(),
  merged: z.boolean().optional(),
  mergedAt: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  author: loginSchema.nullish(),
  assignees: connSchema(loginSchema).nullish(),
  labels: connSchema(labelSchema).nullish(),
  reviews: connSchema(z.object({ author: loginSchema.nullish() })).nullish(),
  reviewRequests: connSchema(z.object({ requestedReviewer: reviewerSchema.nullish() })).nullish(),
  reviewThreads: connSchema(
    z.object({ comments: connSchema(z.object({ author: loginSchema.nullish() })).nullish() }),
  ).nullish(),
  subIssuesSummary: z.unknown().optional(),
  issueDependenciesSummary: z.unknown().optional(),
  timelineItems: connSchema(graphqlTimelineNodeSchema).nullish(),
  // live link connections (discoverLinks)
  parent: refSchema.nullish(),
  subIssues: connSchema(refSchema).nullish(),
  blockedBy: connSchema(refSchema).nullish(),
  blocking: connSchema(refSchema).nullish(),
  closingIssuesReferences: connSchema(refSchema).nullish(),
  closedByPullRequestsReferences: connSchema(refSchema).nullish(),
});
export type GraphqlNode = z.infer<typeof graphqlNodeSchema>;

/** `repository.issue` / `repository.pullRequest` envelope for a single-node read. */
export const repoNodeDataSchema = z.object({
  repository: z
    .object({ issue: graphqlNodeSchema.nullish(), pullRequest: graphqlNodeSchema.nullish() })
    .nullish(),
});
export type RepoNodeData = z.infer<typeof repoNodeDataSchema>;

/** Shallow issue/PR lists for repo sweeps. */
export const repoThreadsDataSchema = z.object({
  repository: z
    .object({
      issues: connSchema(z.object({ number: z.number() })).nullish(),
      pullRequests: connSchema(
        z.object({ number: z.number(), isDraft: z.boolean().optional() }),
      ).nullish(),
    })
    .nullish(),
});
export type RepoThreadsData = z.infer<typeof repoThreadsDataSchema>;
